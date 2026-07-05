/**
 * PRD-009a: the three non-negotiable installer mitigations (is-AC-7/8/9/10).
 *
 * A loopback endpoint that shells out to `npm install` is a drive-by target: any page the operator
 * visits can `fetch` or form-POST at `127.0.0.1:3853`. Every installer request therefore passes:
 *   - HOST validation (is-AC-8, DNS-rebinding defense): a rebound hostname that resolves to
 *     127.0.0.1 still fails because its `Host` header is not the portal's own host.
 *   - ORIGIN validation (is-AC-7): a foreign Origin is rejected 403; a missing Origin on a
 *     state-changing (non-GET) request is rejected too.
 *   - TOKEN validation (is-AC-9): the one-time bootstrap token, constant-time compared. State-
 *     changing endpoints always require it; read-only detection requires it only while a session is
 *     active, staying available token-free after completion for the re-entry short-circuit (is-AC-10).
 */

import type { Context } from "hono";

import { HIVE_HOST, HIVE_PORT } from "../../shared/constants.js";
import type { TokenStore } from "./token.js";

/** The portal's own hosts (is-AC-8). Only these `Host` header values are accepted. */
const ALLOWED_HOSTS = new Set<string>([`${HIVE_HOST}:${HIVE_PORT}`, `localhost:${HIVE_PORT}`]);

/** The portal's own origins (is-AC-7). Only these `Origin` header values are accepted. */
const ALLOWED_ORIGINS = new Set<string>([`http://${HIVE_HOST}:${HIVE_PORT}`, `http://localhost:${HIVE_PORT}`]);

/** The request header carrying the onboarding token (the SSE path uses the `t` query param instead). */
export const TOKEN_HEADER = "x-onboarding-token" as const;

/**
 * Token requirement per endpoint class:
 * - `always`: a valid token is required unconditionally (state-changing installer endpoints).
 * - `detect`: required only while an onboarding session is active (the is-AC-10 re-entry carve-out).
 * - `optional`: a PRESENTED token must be valid, but absence is accepted (PRD-011 N-1: the
 *   telemetry-only event route, so the tokenless gate-redirect resume cohort is still counted;
 *   the Host + Origin checks remain the cross-origin defense on this route).
 */
export type TokenMode = "always" | "detect" | "optional";

/** True iff the `Host` header is the portal's own host (is-AC-8). */
export function hostAllowed(host: string | undefined): boolean {
  return host !== undefined && ALLOWED_HOSTS.has(host);
}

/**
 * Origin policy (is-AC-7): a present Origin must be the portal's own; a missing Origin is allowed
 * only on a safe (GET) request and rejected on any state-changing method.
 */
export function originAllowed(method: string, origin: string | undefined): boolean {
  if (origin === undefined) return method === "GET" || method === "HEAD";
  return ALLOWED_ORIGINS.has(origin);
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" }
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" }
  });
}

function allowsQueryToken(c: Context): boolean {
  const path = new URL(c.req.url).pathname;
  return c.req.method === "GET" && /^\/api\/onboarding\/install\/[^/]+\/events$/.test(path);
}

/** Read the presented token from the header, falling back to the `t` query param only for EventSource. */
export function extractToken(c: Context): string | null {
  const header = c.req.header(TOKEN_HEADER);
  if (header !== undefined && header.length > 0) return header;
  if (!allowsQueryToken(c)) return null;
  const query = c.req.query("t");
  return query !== undefined && query.length > 0 ? query : null;
}

/**
 * Run the full guard for an installer request. Returns a rejection {@link Response} to short-circuit
 * the handler, or `null` when the request passed all three checks. Never logs or echoes the token.
 */
export function guardInstallerRequest(c: Context, tokenStore: TokenStore, tokenMode: TokenMode): Response | null {
  if (!hostAllowed(c.req.header("host"))) return forbidden();
  if (!originAllowed(c.req.method, c.req.header("origin"))) return forbidden();

  const provided = extractToken(c);
  if (tokenMode === "always") {
    if (!tokenStore.requireValid(provided)) return unauthorized();
    return null;
  }

  // "optional" (PRD-011 N-1): tokenless is accepted (the gate-redirect resume path has no token
  // by design, ts-AC-12); a token that IS presented must still validate, so token-bearing
  // behavior is unchanged and a wrong token never passes.
  if (tokenMode === "optional") {
    if (provided !== null && !tokenStore.requireValid(provided)) return unauthorized();
    return null;
  }

  // "detect": token required only while an onboarding session is active (is-AC-10 carve-out).
  if (tokenStore.isActive() && !tokenStore.requireValid(provided)) return unauthorized();
  return null;
}
