import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  type LockPaths
} from "../lock.js";
import {
  HIVEDOCTOR_STATUS_URL,
  THEHIVE_HOST,
  THEHIVE_PORT,
  THEHIVE_VERSION
} from "../shared/constants.js";
import { mountDashboardHost } from "./dashboard/host.js";
import { fetchFleetStatus, type FetchImpl } from "./fleet-status.js";
import { createApiProxy, type ProxyFetch } from "./proxy.js";

export interface CreateThehiveOptions {
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => number;
  readonly registryPath?: string;
  readonly fleetStatusFetch?: FetchImpl;
  readonly hivedoctorStatusUrl?: string;
  /** The fetch used by the API proxy to reach workload daemons over loopback (defaults to the global `fetch`). */
  readonly proxyFetch?: ProxyFetch;
}

export interface StartThehiveOptions extends CreateThehiveOptions {
  readonly lockPaths?: Partial<LockPaths>;
  readonly serveFn?: ServeFunction;
}

export interface ThehiveInstance {
  readonly app: Hono;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}

export interface StartedThehive extends ThehiveInstance {
  readonly lockPaths: LockPaths;
  stop(): Promise<void>;
}

type ServeFunction = typeof serve;
type ListeningServer = ReturnType<ServeFunction>;

function closeServer(server: ListeningServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error instanceof Error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createThehive(options: CreateThehiveOptions = {}): ThehiveInstance {
  const host = options.host ?? THEHIVE_HOST;
  const port = options.port ?? THEHIVE_PORT;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const app = new Hono();
  mountDashboardHost(app);

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      uptimeMs: Math.max(0, now() - startedAt),
      version: THEHIVE_VERSION
    })
  );

  const fleetStatusFetch = options.fleetStatusFetch ?? fetch;
  const hivedoctorStatusUrl = options.hivedoctorStatusUrl ?? HIVEDOCTOR_STATUS_URL;

  // thehive-owned data route: aggregates hivedoctor's supervisor status. Registered BEFORE the
  // catch-all proxy so it wins (Hono runs matching handlers in registration order).
  app.get("/api/fleet-status", async (c) =>
    c.json(await fetchFleetStatus(fleetStatusFetch, hivedoctorStatusUrl))
  );

  // Server-side federation (BFF): every other `/api/*` and `/setup/*` request is proxied over
  // loopback to the workload daemon that owns it (honeycomb or hivenectar), resolved from
  // hivedoctor's registry. The browser only ever talks to thehive's own origin.
  const apiProxy = createApiProxy({ registryPath: options.registryPath, fetchImpl: options.proxyFetch });
  app.all("/api/*", apiProxy);
  app.all("/setup/*", apiProxy);

  return {
    app,
    host,
    port,
    startedAt
  };
}

export function startThehive(options: StartThehiveOptions = {}): StartedThehive {
  const serveFn = options.serveFn ?? serve;
  const thehive = createThehive(options);
  const lockPaths = acquireSingleInstanceLock(options.lockPaths);

  let server: ListeningServer;
  try {
    server = serveFn({
      fetch: thehive.app.fetch,
      hostname: thehive.host,
      port: thehive.port
    });
  } catch (error) {
    releaseSingleInstanceLock(lockPaths);
    throw error;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await closeServer(server);
    } finally {
      releaseSingleInstanceLock(lockPaths);
    }
  };

  return {
    ...thehive,
    lockPaths,
    stop
  };
}
