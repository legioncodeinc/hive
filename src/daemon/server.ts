import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  type LockPaths
} from "../lock.js";
import {
  THEHIVE_HOST,
  THEHIVE_PORT,
  THEHIVE_VERSION
} from "../shared/constants.js";
import { mountDashboardHost } from "./dashboard/host.js";
import { resolveDaemonBases } from "./registry.js";

export interface CreateThehiveOptions {
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => number;
  readonly registryPath?: string;
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

  app.get("/api/daemon-bases", (c) => c.json(resolveDaemonBases({ registryPath: options.registryPath })));

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
