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
import { mountDashboardAssets, mountDashboardShellFallback, renderShell } from "./dashboard/host.js";
import { fetchFleetStatus, type FetchImpl } from "./fleet-status.js";
import { createPortalGate } from "./gate.js";
import { createApiProxy, type ProxyFetch } from "./proxy.js";
import { resolveRegisteredServiceNames } from "./registry.js";
import { createTelemetryStreamHandler, type TelemetryFetch } from "./telemetry-proxy.js";
import type { SetupAuthFetchImpl } from "./setup-auth.js";

export interface CreateThehiveOptions {
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => number;
  readonly registryPath?: string;
  readonly fleetStatusFetch?: FetchImpl;
  readonly hivedoctorStatusUrl?: string;
  /** The fetch used by the API proxy to reach workload daemons over loopback (defaults to the global `fetch`). */
  readonly proxyFetch?: ProxyFetch;
  /** The fetch used by the portal gate's auth check (`/setup/state`, defaults to the global `fetch`). */
  readonly setupAuthFetch?: SetupAuthFetchImpl;
  /** Override hivedoctor's SSE events URL the telemetry relay connects to (defaults to the fixed loopback constant). */
  readonly hivedoctorEventsUrl?: string;
  /** The fetch used by the telemetry relay to reach hivedoctor's SSE stream (defaults to the global `fetch`). */
  readonly telemetryStreamFetch?: TelemetryFetch;
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

  const fleetStatusFetch = options.fleetStatusFetch ?? fetch;
  const hivedoctorStatusUrl = options.hivedoctorStatusUrl ?? HIVEDOCTOR_STATUS_URL;

  // PRD-003a: the server-side portal landing gate, registered FIRST so it runs ahead of every
  // other route. It bypasses thehive's own infra/asset/proxy paths and the two exempt screens
  // (`/buzzing`, `/login`) internally; for every other path it evaluates health-then-auth and
  // either redirects or falls through via `next()` to the routes below.
  app.use(
    "*",
    createPortalGate({
      fleetStatusFetch,
      hivedoctorStatusUrl,
      setupAuthFetch: options.setupAuthFetch,
      registryPath: options.registryPath
    })
  );

  // The bundled SPA's static assets — specific, fixed paths registered before the shell catch-all
  // (below) so they win.
  mountDashboardAssets(app);

  // PRD-005b: `/health` is content-negotiated (the gate makes the same distinction, `gate.ts`
  // `isInfraPath`). A machine probe (hivedoctor's own liveness check, monitoring) never asks for
  // HTML and gets the existing cheap liveness JSON unchanged; a browser navigating to the new
  // operator-facing `/health` page asks for HTML and gets the SAME SPA shell every other gated
  // route renders (the bundled client resolves the `/health` registry page itself).
  app.get("/health", (c) => {
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      c.header("cache-control", "no-cache");
      return c.html(renderShell());
    }
    return c.json({
      status: "ok",
      uptimeMs: Math.max(0, now() - startedAt),
      version: THEHIVE_VERSION
    });
  });

  // thehive-owned data route: aggregates hivedoctor's supervisor status. Registered BEFORE the
  // catch-all proxy so it wins (Hono runs matching handlers in registration order).
  app.get("/api/fleet-status", async (c) =>
    c.json(await fetchFleetStatus(fleetStatusFetch, hivedoctorStatusUrl))
  );

  // PRD-004a/PRD-005a: the full list of hivedoctor-REGISTERED service names, even one thehive's
  // BFF proxy never routes to (e.g. hivedoctor/thehive itself). Lets `/buzzing` and the health
  // rail render one tile/pill per registered service before any telemetry has arrived at all
  // (bz-AC-1/bz-AC-2, hr-AC-1), independent of whichever daemons `resolveDaemonBases` proxies for.
  app.get("/api/registered-services", (c) =>
    c.json({ names: resolveRegisteredServiceNames({ registryPath: options.registryPath }) })
  );

  // PRD-004/PRD-005: the same-origin relay of hivedoctor's fleet-telemetry SSE stream
  // (`telemetry-proxy.ts`). Registered BEFORE the generic `/api/*` proxy so THIS specific route
  // wins; the browser only ever opens `/api/telemetry/stream`, never hivedoctor's `:3852` directly.
  app.get(
    "/api/telemetry/stream",
    createTelemetryStreamHandler({
      hivedoctorEventsUrl: options.hivedoctorEventsUrl,
      fetchImpl: options.telemetryStreamFetch
    })
  );

  // Server-side federation (BFF): every other `/api/*` and `/setup/*` request is proxied over
  // loopback to the workload daemon that owns it (honeycomb or hivenectar), resolved from
  // hivedoctor's registry. The browser only ever talks to thehive's own origin.
  const apiProxy = createApiProxy({ registryPath: options.registryPath, fetchImpl: options.proxyFetch });
  app.all("/api/*", apiProxy);
  app.all("/setup/*", apiProxy);

  // PRD-003a: the SPA shell catch-all — MUST be registered LAST so every specific route above
  // (assets, /health, /api/fleet-status, the BFF proxy) wins. Serves every gated page path the
  // gate let through, plus `/buzzing` and `/login` themselves, plus any unknown deep link.
  mountDashboardShellFallback(app);

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
