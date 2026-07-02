/**
 * The gate's AUTH input — PRD-003a/003b: "logged in" is credential presence, read through the
 * proxied honeycomb `GET /setup/state` `authenticated` bit (no new portal session, ADR-0004).
 *
 * This mirrors `fleet-status.ts`'s shape deliberately: a small, injectable, fail-soft fetch that
 * resolves the SAME honeycomb base the real `/setup/*` BFF proxy (`proxy.ts`) resolves requests to
 * (via `resolveDaemonBases`), re-checks it is loopback (defense in depth, same posture as the
 * proxy and `fleet-status.ts`), and degrades to `false` (not authenticated) on ANY failure —
 * a non-loopback base, a network error, a non-OK response, invalid JSON, or a schema mismatch.
 * l-AC-6 requires exactly this: a `/setup/state` fetch failure or timeout must read as "not logged
 * in" (redirect to `/login`), never fail-soft into the dashboard.
 */

import { z } from "zod";

import { isLoopbackBaseUrl } from "../shared/daemon-routing.js";
import { resolveDaemonBases } from "./registry.js";

const SetupStateAuthSchema = z.object({
  authenticated: z.boolean().catch(false)
});

/** Minimal init surface for the auth fetch (mirrors `fleet-status.ts`'s `FleetFetchInit`). */
export type SetupAuthFetchInit = {
  readonly redirect?: "error" | "follow" | "manual";
  /** Ties the upstream `/setup/state` fetch to the caller's lifecycle (e.g. the incoming request). */
  readonly signal?: AbortSignal;
};
export type SetupAuthFetchImpl = (input: string, init?: SetupAuthFetchInit) => Promise<Response>;

export interface FetchSetupAuthenticatedOptions {
  /** Override the hivedoctor registry file path the honeycomb base is resolved from. */
  readonly registryPath?: string;
  /**
   * Abort signal forwarded to the underlying fetch, so a disconnected client (the gate passes
   * `c.req.raw.signal`) never leaves a hung `/setup/state` request pinned upstream. An abort
   * surfaces as a rejected fetch and therefore resolves `false`, the same fail-closed posture
   * as every other failure mode here.
   */
  readonly signal?: AbortSignal;
}

/**
 * Resolve "is the operator logged in" for the gate's auth step (g-AC-4, l-AC-4). Reads the SAME
 * honeycomb base the BFF proxy would (`resolveDaemonBases`), fetches `/setup/state` over loopback,
 * and returns its `authenticated` bit. Fails closed to `false` on any error so a transient fault
 * never fail-softs an unauthenticated visitor into the dashboard (l-AC-6).
 */
export async function fetchSetupAuthenticated(
  fetchImpl: SetupAuthFetchImpl = fetch,
  options: FetchSetupAuthenticatedOptions = {}
): Promise<boolean> {
  const base = resolveDaemonBases({ registryPath: options.registryPath }).honeycomb;
  // Defense in depth, mirroring proxy.ts / fleet-status.ts: resolveDaemonBases only ever returns
  // loopback origins, but a future change to base resolution must never turn this into an
  // off-loopback fetch that could leak the request (or its redirect) off thehive's trust boundary.
  if (!isLoopbackBaseUrl(base)) return false;

  try {
    const response = await fetchImpl(`${base}/setup/state`, { redirect: "error", signal: options.signal });
    if (!response.ok) return false;

    let parsedJson: unknown;
    try {
      parsedJson = await response.json();
    } catch {
      return false;
    }

    const parsed = SetupStateAuthSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data.authenticated : false;
  } catch {
    // Network error, refused connection, timeout, or a blocked redirect: fail CLOSED (not logged in).
    return false;
  }
}
