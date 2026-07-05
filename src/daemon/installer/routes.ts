/**
 * PRD-009a: the `/api/onboarding/*` installer surface and its service factory.
 *
 * These Hono routes are registered on hive's app BEFORE the generic `/api/*` BFF proxy (the same
 * registration-order discipline as `/api/fleet-status` and `/api/telemetry/stream`), so hive itself
 * answers them rather than proxying to a workload daemon. Every route runs the three-check guard
 * (`security.ts`): Host, Origin, and the one-time token. Manifest resolution, detection, the install
 * state machine, and the token store are all reached through the injectable config, so a test never
 * hits the network, real npm, or the real filesystem.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { DOCTOR_STATUS_URL } from "../../shared/constants.js";
import type { EmitDeps } from "../../telemetry/emit.js";
import type { ProgressSubscriber } from "./install-state.js";
import { createInstallStateStore, type InstallStateStore } from "./install-state.js";
import { createInstallerConfig, type InstallerConfig } from "./config.js";
import { createManifestResolver, type ManifestResolver } from "./manifest.js";
import { createTokenStore, type TokenStore } from "./token.js";
import { detectFleet, installedVersion } from "./detection.js";
import { isInstallableProduct } from "./products.js";
import { resolveNpmPrefixViaCli } from "./bin-resolver.js";
import { guardInstallerRequest } from "./security.js";
import {
  createFunnelTelemetry,
  OnboardingEventBodySchema,
  type FunnelTelemetry
} from "./funnel-telemetry.js";
import { fetchSetupAuthenticated, type SetupAuthFetchImpl } from "../setup-auth.js";
import {
  fetchFleetStatus,
  isFleetReady,
  type FetchImpl as FleetFetchImpl
} from "../fleet-status.js";

/** Service options: the installer config seams plus the fleet-status inputs the health check reuses. */
export interface InstallerServiceOptions extends Partial<InstallerConfig> {
  /** The fetch used by the health check's `fetchFleetStatus` (defaults to the global `fetch`). */
  readonly fleetStatusFetch?: FleetFetchImpl;
  /** Override doctor's status URL for the health check (defaults to the fixed loopback constant). */
  readonly doctorStatusUrl?: string;
  /** Fetch seam for `/setup/state` auth observation (`login_completed`, PRD-009c). */
  readonly setupAuthFetch?: SetupAuthFetchImpl;
  /** Injectable telemetry deps for funnel emission (tests record POST bodies). */
  readonly funnelEmitDeps?: EmitDeps;
  /** Override onboarding session ledger dir (tests). */
  readonly funnelStateDir?: string;
}

/** The assembled installer service: a route registrar plus its state (exposed for tests). */
export interface InstallerService {
  register(app: Hono): void;
  readonly config: InstallerConfig;
  readonly store: InstallStateStore;
  readonly tokenStore: TokenStore;
  readonly manifest: ManifestResolver;
  readonly funnel: FunnelTelemetry;
}

const InstallBodySchema = z.object({ product: z.string() });

function jsonError(c: Context, status: 400 | 401 | 403 | 409, error: string): Response {
  return c.json({ error }, status);
}

async function readJsonBody(c: Context): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Build the installer service with a memoized npm-prefix resolver over the injected seams. */
export function createInstallerService(options: InstallerServiceOptions = {}): InstallerService {
  const base = createInstallerConfig(options);

  // Memoize `npm prefix -g` so it runs at most once per daemon session (is-AC: prefix cached).
  let prefixPromise: Promise<string | null> | null = null;
  const config: InstallerConfig = {
    ...base,
    resolveNpmPrefix: () => {
      if (prefixPromise === null) {
        prefixPromise = options.resolveNpmPrefix ? options.resolveNpmPrefix() : resolveNpmPrefixViaCli(config);
      }
      return prefixPromise;
    }
  };

  const funnel = createFunnelTelemetry({
    config,
    emitDeps: options.funnelEmitDeps,
    stateDir: options.funnelStateDir
  });

  const store = createInstallStateStore(config, {
    onInstallStarted: (product) => funnel.recordProductInstallStarted(product),
    onInstallCompleted: (product) => funnel.recordProductInstallCompleted(product),
    onInstallFailed: (product, stage) => funnel.recordProductInstallFailed(product, stage)
  });
  const tokenStore = createTokenStore(config);
  const manifest = createManifestResolver(config);

  const fleetStatusFetch = options.fleetStatusFetch ?? fetch;
  const setupAuthFetch = options.setupAuthFetch ?? fetch;
  const doctorStatusUrl = options.doctorStatusUrl ?? DOCTOR_STATUS_URL;

  const register = (app: Hono): void => {
    // 1) Detection (is-AC-1/2). Token required only while a session is active (is-AC-10 carve-out).
    app.get("/api/onboarding/detect", async (c) => {
      const rejection = guardInstallerRequest(c, tokenStore, "detect");
      if (rejection !== null) return rejection;
      return c.json(await detectFleet(config, store));
    });

    // 2) Install start (is-AC-3/4/5/15/16). Server resolves the target; the request carries only a slug.
    app.post("/api/onboarding/install", async (c) => {
      const rejection = guardInstallerRequest(c, tokenStore, "always");
      if (rejection !== null) return rejection;

      const body = await readJsonBody(c);
      const parsed = InstallBodySchema.safeParse(body);
      if (!parsed.success) return jsonError(c, 400, "invalid_body");

      // is-AC-3: only the four slugs; `hive` is not installable. Either way a 400 with no spawn.
      const product = parsed.data.product;
      if (!isInstallableProduct(product)) return jsonError(c, 400, "invalid_product");

      // is-AC-4/5: resolve `packageName@version` server-side, refusing rather than falling to @latest.
      const resolution = await manifest.resolve(product);
      if (resolution.kind === "unpublished") return jsonError(c, 409, "unpublished");
      if (resolution.kind === "manifest_unresolved") return jsonError(c, 409, "manifest_unresolved");

      // is-AC-15: already installed at the pinned version -> short-circuit, never spawn npm.
      const snapshot = store.detectState(product);
      const detectedVersion = await installedVersion(config, product);
      if (snapshot.status === "installed" || detectedVersion === resolution.version) {
        return c.json({ product, state: "installed" }, 200);
      }

      // is-AC-16: begin (or attach to an in-flight install); either way the wire state is in_progress.
      store.begin(product, {
        packageName: resolution.packageName,
        version: resolution.version,
        target: resolution.target
      });
      return c.json({ product, state: "install_in_progress" }, 202);
    });

    // 3) SSE progress (is-AC-11/12/14). Mirrors the telemetry-proxy relay discipline: a streamed
    //    body, no buffering beyond the current event, tied to the request's abort signal.
    app.get("/api/onboarding/install/:product/events", (c) => {
      const rejection = guardInstallerRequest(c, tokenStore, "always");
      if (rejection !== null) return rejection;

      const product = c.req.param("product");
      if (!isInstallableProduct(product)) return jsonError(c, 400, "invalid_product");

      const signal = c.req.raw.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const subscriber: ProgressSubscriber = {
            send(event) {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                closed = true;
              }
            },
            close() {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {
                // The stream may already be closed by a client disconnect; nothing to do.
              }
            }
          };

          const unsubscribe = store.subscribe(product, subscriber);
          const onAbort = (): void => {
            unsubscribe();
            subscriber.close();
          };
          // is-AC-14: a client disconnect removes this subscriber but the install continues.
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive"
        }
      });
    });

    // 4) Health check (is-AC-18): reuse the existing readiness projection, do not re-derive it.
    app.get("/api/onboarding/health", async (c) => {
      const rejection = guardInstallerRequest(c, tokenStore, "always");
      if (rejection !== null) return rejection;
      const status = await fetchFleetStatus(fleetStatusFetch, doctorStatusUrl);
      const ready = isFleetReady(status);
      funnel.observeHealthReady(ready);
      const authenticated = await fetchSetupAuthenticated(setupAuthFetch, { signal: c.req.raw.signal });
      funnel.observeAuthenticated(authenticated);
      return c.json({ ready, status });
    });

    // 5) Completion (is-AC-10): invalidate the token (delete the file + set the memory flag), 204.
    app.post("/api/onboarding/complete", (c) => {
      const rejection = guardInstallerRequest(c, tokenStore, "always");
      if (rejection !== null) return rejection;
      tokenStore.invalidate();
      return c.body(null, 204);
    });

    // 6) Funnel events (PRD-009c): closed UI event set, emitted through the chokepoint. Token
    //    mode is "optional" (PRD-011 N-1): the tokenless gate-redirect resume path (C-1) must
    //    still be able to record tenancy_shown / tenancy_selected / dashboard_reached, or the
    //    resume cohort is silently undercounted; a presented token still validates as before.
    //    This route is telemetry-only (no state change), Host + Origin guarded like the rest.
    app.post("/api/onboarding/event", async (c) => {
      const rejection = guardInstallerRequest(c, tokenStore, "optional");
      if (rejection !== null) return rejection;
      const body = await readJsonBody(c);
      const parsed = OnboardingEventBodySchema.safeParse(body);
      if (!parsed.success) return jsonError(c, 400, "invalid_body");
      funnel.recordUiEvent(parsed.data);
      const authenticated = await fetchSetupAuthenticated(setupAuthFetch, { signal: c.req.raw.signal });
      funnel.observeAuthenticated(authenticated);
      return c.body(null, 202);
    });
  };

  return { register, config, store, tokenStore, manifest, funnel };
}
