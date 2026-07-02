/**
 * The server-side PORTAL LANDING GATE — PRD-003a, implementing ADR-0004's precedence.
 *
 * On landing on ANY non-exempt route hive evaluates ONE ordered precedence, health then auth,
 * before deciding what to serve:
 *
 *   1. Fleet not healthy (per the EXISTING `isFleetReady()` projection, `fleet-status.ts`) →
 *      redirect to `/buzzing` (g-AC-3). Checked FIRST: an unhealthy fleet makes every other screen
 *      useless, so auth is never even evaluated in this branch.
 *   2. Else not logged in (the EXISTING proxied honeycomb `/setup/state` `authenticated` bit,
 *      `setup-auth.ts`) → redirect to `/login` (g-AC-4). A fetch failure/timeout reads as "not
 *      logged in" (l-AC-6) — never a fail-soft into the dashboard.
 *   3. Else serve the requested route as-is (g-AC-5 / g-AC-6): `next()` falls through to the
 *      more specific route/catch-all registered after this middleware in `server.ts`.
 *
 * `/buzzing` and `/login` are a FIXED exemption set checked BEFORE the precedence above, so they
 * are always served directly and the redirect can never loop (g-AC-7 / g-AC-8 / g-AC-9): the only
 * two redirect destinations are themselves exempt from producing another redirect.
 *
 * This middleware also bypasses hive's own infra: `/health` (this daemon's own liveness, not a
 * portal screen), the bundled asset routes (`/app.js`, `/styles.css`, the logo, `/fonts/*` — these
 * must load even when the shell just redirected the BROWSER to `/buzzing` or `/login`, since the
 * exempt screens are the same SPA bundle), and the `/api/*` / `/setup/*` data-plane proxy (that is
 * an existing same-origin API surface, not a page navigation the gate should ever intercept or
 * redirect — g-AC-11's "no open redirect" posture, plus l-AC-2's "all `/setup/*` traffic stays
 * same-origin", both depend on the proxy handling its own requests untouched).
 *
 * SECURITY (g-AC-11, open-redirect defense): every redirect this middleware issues targets a
 * FIXED, hard-coded literal (`/buzzing` or `/login`) — never a value derived from user input (no
 * `?next=`, no `Referer`, no request path echoed back). This makes an open redirect structurally
 * impossible here: there is no code path where an attacker-controlled string reaches `c.redirect`.
 */

import type { Context, MiddlewareHandler } from "hono";

import { DOCTOR_STATUS_URL } from "../shared/constants.js";
import { isFleetReady } from "../shared/fleet-readiness.js";
import { fetchFleetStatus, type FetchImpl as FleetFetchImpl } from "./fleet-status.js";
import { fetchSetupAuthenticated, type SetupAuthFetchImpl } from "./setup-auth.js";

/** The fixed redirect target for an unhealthy fleet (g-AC-3). A hard-coded literal, never derived. */
const BUZZING_ROUTE = "/buzzing" as const;

/** The fixed redirect target for a logged-out operator (g-AC-4). A hard-coded literal, never derived. */
const LOGIN_ROUTE = "/login" as const;

/** The only two gate-exempt SCREENS (g-AC-7 / g-AC-8): always served directly, never redirected. */
export const GATE_EXEMPT_ROUTES = [BUZZING_ROUTE, LOGIN_ROUTE] as const;

/**
 * hive's OWN liveness route + the bundled SPA asset routes — never a page navigation to gate.
 * `/health` is deliberately NOT in this set (see {@link isInfraPath}): PRD-005b claims that same
 * literal path for the operator-facing `/health` page, so it needs content-negotiated handling
 * rather than a blanket exemption.
 */
const GATE_EXEMPT_INFRA_PATHS = new Set<string>(["/app.js", "/styles.css", "/honeycomb-memory-cluster.svg"]);

/** Path PREFIXES that are data-plane traffic (the BFF proxy, fonts), never a gated page route. */
const GATE_EXEMPT_INFRA_PREFIXES = ["/api/", "/setup/", "/fonts/"] as const;

/**
 * hive's own machine-liveness path. Ambiguous on purpose (PRD-005b): a health-probe/monitoring
 * caller (doctor's own `/health` probe, an ops tool) never sends `Accept: text/html`, while a
 * browser navigating to the new `/health` OPERATOR page always does. `server.ts`'s `/health`
 * handler makes the SAME distinction so the two behaviors stay in lockstep.
 */
const LIVENESS_PATH = "/health" as const;

/** True iff `accept` prefers HTML — the signal that distinguishes a page navigation from a machine probe. */
function prefersHtml(accept: string): boolean {
  return accept.includes("text/html");
}

/**
 * True for hive's own infra/asset/proxy surface — bypasses the gate entirely (see module doc).
 * `/health` is infra ONLY when the caller is not asking for HTML (a liveness probe); an
 * HTML-accepting request to `/health` is treated as a normal page route so it gets the same
 * buzzing/login precedence as every other SPA route (PRD-005b).
 */
function isInfraPath(pathname: string, accept: string): boolean {
  if (pathname === LIVENESS_PATH) return !prefersHtml(accept);
  if (GATE_EXEMPT_INFRA_PATHS.has(pathname)) return true;
  return GATE_EXEMPT_INFRA_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** True for the two gate-exempt screens (`/buzzing`, `/login`) — always served directly. */
function isExemptRoute(pathname: string): boolean {
  return (GATE_EXEMPT_ROUTES as readonly string[]).includes(pathname);
}

export interface CreatePortalGateOptions {
  /** The fetch used for the health check (defaults to the global `fetch`; a test injects a fake). */
  readonly fleetStatusFetch?: FleetFetchImpl;
  /** Override doctor's status URL (defaults to the fixed loopback constant). */
  readonly doctorStatusUrl?: string;
  /** The fetch used for the auth check (defaults to the global `fetch`; a test injects a fake). */
  readonly setupAuthFetch?: SetupAuthFetchImpl;
  /** Override the doctor registry file path the auth check resolves honeycomb's base from. */
  readonly registryPath?: string;
}

/**
 * Build the portal landing gate middleware (g-AC-1..11). Register it FIRST on hive's Hono app
 * (`app.use("*", createPortalGate(...))`) so it runs ahead of every other route. It never renders
 * a response itself for the passing case — it calls `next()` and lets the routes registered after
 * it (the asset routes, `/health`, `/api/fleet-status`, the BFF proxy, and finally the SPA shell
 * catch-all) serve the request, exactly as they do today for the paths this gate bypasses.
 */
export function createPortalGate(options: CreatePortalGateOptions = {}): MiddlewareHandler {
  const fleetStatusFetch = options.fleetStatusFetch ?? fetch;
  const doctorStatusUrl = options.doctorStatusUrl ?? DOCTOR_STATUS_URL;
  const setupAuthFetch = options.setupAuthFetch ?? fetch;
  const registryPath = options.registryPath;

  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const pathname = new URL(c.req.url).pathname;
    const accept = c.req.header("accept") ?? "";

    // hive's own infra/asset/proxy surface: never a page navigation, never gated.
    if (isInfraPath(pathname, accept)) {
      await next();
      return undefined;
    }

    // g-AC-7 / g-AC-8: the exemption set is checked BEFORE the precedence, so `/buzzing` and
    // `/login` are ALWAYS served directly — this is what guarantees the redirect below can never
    // loop (g-AC-9): the only two redirect targets are themselves exempt from producing another.
    if (isExemptRoute(pathname)) {
      await next();
      return undefined;
    }

    // g-AC-3: health first, before auth is even evaluated. Reuses the SAME `isFleetReady()`
    // predicate `/buzzing`'s own readiness view will read (PRD-002a), so "healthy" means one
    // thing across the gate and the screen it redirects to.
    const fleetStatus = await fetchFleetStatus(fleetStatusFetch, doctorStatusUrl);
    if (!isFleetReady(fleetStatus)) {
      return c.redirect(BUZZING_ROUTE, 302);
    }

    // g-AC-4 / l-AC-4 / l-AC-6: auth second. A fetch failure/timeout resolves to `false` inside
    // `fetchSetupAuthenticated`, so a transient proxy fault falls to `/login`, never the dashboard.
    // The incoming request's abort signal is threaded through so a client disconnect aborts the
    // upstream `/setup/state` fetch instead of pinning it (an abort also reads as fail-closed).
    const authenticated = await fetchSetupAuthenticated(setupAuthFetch, { registryPath, signal: c.req.raw.signal });
    if (!authenticated) {
      return c.redirect(LOGIN_ROUTE, 302);
    }

    // g-AC-5 / g-AC-6 / g-AC-10: healthy + authenticated — serve the requested route as-is (the
    // SPA shell catch-all defaults `/` to the dashboard; nothing here re-derives a fallback path).
    await next();
    return undefined;
  };
}
