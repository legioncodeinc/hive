import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  type LockPaths
} from "../lock.js";
import { registerHiveWithDoctor } from "../install/registry.js";
import { migrateHiveState } from "../shared/state-migration.js";
import {
  DOCTOR_STATUS_URL,
  HIVE_HOST,
  HIVE_PORT,
  HIVE_VERSION
} from "../shared/constants.js";
import { mountDashboardAssets, mountDashboardShellFallback, renderShell } from "./dashboard/host.js";
import { fetchFleetStatus, type FetchImpl } from "./fleet-status.js";
import { createPortalGate } from "./gate.js";
import { createApiProxy, type ProxyFetch } from "./proxy.js";
import { resolveRegisteredServiceNames } from "./registry.js";
import { createTelemetryStreamHandler, type TelemetryFetch } from "./telemetry-proxy.js";
import { createInstallerService, type InstallerServiceOptions } from "./installer/index.js";
import type { SetupAuthFetchImpl } from "./setup-auth.js";
import type { SetupTenancyFetchImpl } from "./setup-tenancy.js";

export interface CreateHiveOptions {
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => number;
  readonly registryPath?: string;
  readonly fleetStatusFetch?: FetchImpl;
  readonly doctorStatusUrl?: string;
  /** The fetch used by the API proxy to reach workload daemons over loopback (defaults to the global `fetch`). */
  readonly proxyFetch?: ProxyFetch;
  /** The fetch used by the portal gate's auth check (`/setup/state`, defaults to the global `fetch`). */
  readonly setupAuthFetch?: SetupAuthFetchImpl;
  /** The fetch used by the portal gate's tenancy check (`/setup/tenancy`, defaults to the global `fetch`). */
  readonly setupTenancyFetch?: SetupTenancyFetchImpl;
  /** Override doctor's SSE events URL the telemetry relay connects to (defaults to the fixed loopback constant). */
  readonly doctorEventsUrl?: string;
  /** The fetch used by the telemetry relay to reach doctor's SSE stream (defaults to the global `fetch`). */
  readonly telemetryStreamFetch?: TelemetryFetch;
  /**
   * PRD-009a: installer-service seams (manifest fetch, spawn, token/npm-prefix resolution, fs).
   * A test injects fakes here so the onboarding endpoints never touch the network or real npm.
   */
  readonly installer?: InstallerServiceOptions;
}

export interface StartHiveOptions extends CreateHiveOptions {
  readonly lockPaths?: Partial<LockPaths>;
  readonly serveFn?: ServeFunction;
  /**
   * PRD-010b boot-migration seam. Defaults to the real {@link migrateHiveState}; tests MUST
   * inject a no-op (or the suite-wide isolated home applies) so no test touches the real home.
   */
  readonly migrateState?: () => void;
  /**
   * rc-AC-2/mg-AC-7 registry-upsert seam, invoked AFTER the lock is acquired and the pid file is
   * written (same boot, pinned ordering). Defaults to the real {@link registerHiveWithDoctor};
   * tests inject a no-op or a recorder.
   */
  readonly registerWithDoctor?: () => void;
}

export interface HiveInstance {
  readonly app: Hono;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}

export interface StartedHive extends HiveInstance {
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

export function createHive(options: CreateHiveOptions = {}): HiveInstance {
  const host = options.host ?? HIVE_HOST;
  const port = options.port ?? HIVE_PORT;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const app = new Hono();

  const fleetStatusFetch = options.fleetStatusFetch ?? fetch;
  const doctorStatusUrl = options.doctorStatusUrl ?? DOCTOR_STATUS_URL;

  // PRD-003a: the server-side portal landing gate, registered FIRST so it runs ahead of every
  // other route. It bypasses hive's own infra/asset/proxy paths and the two exempt screens
  // (`/buzzing`, `/login`) internally; for every other path it evaluates health-then-auth and
  // either redirects or falls through via `next()` to the routes below.
  app.use(
    "*",
    createPortalGate({
      fleetStatusFetch,
      doctorStatusUrl,
      setupAuthFetch: options.setupAuthFetch,
      setupTenancyFetch: options.setupTenancyFetch,
      registryPath: options.registryPath
    })
  );

  // The bundled SPA's static assets — specific, fixed paths registered before the shell catch-all
  // (below) so they win.
  mountDashboardAssets(app);

  // PRD-005b: `/health` is content-negotiated (the gate makes the same distinction, `gate.ts`
  // `isInfraPath`). A machine probe (doctor's own liveness check, monitoring) never asks for
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
      version: HIVE_VERSION
    });
  });

  // hive-owned data route: aggregates doctor's supervisor status. Registered BEFORE the
  // catch-all proxy so it wins (Hono runs matching handlers in registration order).
  app.get("/api/fleet-status", async (c) =>
    c.json(await fetchFleetStatus(fleetStatusFetch, doctorStatusUrl))
  );

  // PRD-004a/PRD-005a: the full list of doctor-REGISTERED service names, even one hive's
  // BFF proxy never routes to (e.g. doctor/hive itself). Lets `/buzzing` and the health
  // rail render one tile/pill per registered service before any telemetry has arrived at all
  // (bz-AC-1/bz-AC-2, hr-AC-1), independent of whichever daemons `resolveDaemonBases` proxies for.
  app.get("/api/registered-services", (c) =>
    c.json({ names: resolveRegisteredServiceNames({ registryPath: options.registryPath }) })
  );

  // PRD-004/PRD-005: the same-origin relay of doctor's fleet-telemetry SSE stream
  // (`telemetry-proxy.ts`). Registered BEFORE the generic `/api/*` proxy so THIS specific route
  // wins; the browser only ever opens `/api/telemetry/stream`, never doctor's `:3852` directly.
  app.get(
    "/api/telemetry/stream",
    createTelemetryStreamHandler({
      doctorEventsUrl: options.doctorEventsUrl,
      fetchImpl: options.telemetryStreamFetch
    })
  );

  // PRD-009a: the onboarding installer service (detection, install start, SSE progress, health,
  // completion, funnel-event stub). Registered BEFORE the generic `/api/*` proxy so these specific
  // `/api/onboarding/*` routes win (same registration-order discipline as `/api/fleet-status`). Its
  // health check reuses the SAME fleet-status fetch + doctor URL the gate uses; a test can override
  // any installer seam (manifest fetch, spawn, token/npm-prefix, fs) via `options.installer`.
  createInstallerService({ fleetStatusFetch, doctorStatusUrl, ...options.installer }).register(app);

  // Server-side federation (BFF): every other `/api/*` and `/setup/*` request is proxied over
  // loopback to the workload daemon that owns it (honeycomb or nectar), resolved from
  // doctor's registry. The browser only ever talks to hive's own origin.
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

export function startHive(options: StartHiveOptions = {}): StartedHive {
  const serveFn = options.serveFn ?? serve;
  const migrateState = options.migrateState ?? ((): void => {
    migrateHiveState();
  });
  const registerWithDoctor = options.registerWithDoctor ?? ((): void => {
    registerHiveWithDoctor();
  });

  migrateState();
  const hive = createHive(options);
  const lockPaths = acquireSingleInstanceLock(options.lockPaths);

  // rc-AC-2/mg-AC-7 ordering: the lock is held and the new pid file is written; NOW upsert the
  // registry entry naming that pid path, in the same boot. Best-effort: boot never fails when the
  // registry file is mid-move.
  try {
    registerWithDoctor();
  } catch {
    // Fail-soft by design.
  }

  let server: ListeningServer;
  try {
    server = serveFn({
      fetch: hive.app.fetch,
      hostname: hive.host,
      port: hive.port
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
    ...hive,
    lockPaths,
    stop
  };
}
