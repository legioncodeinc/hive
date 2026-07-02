/**
 * hive server-side API proxy: the BFF (backend-for-frontend) federation layer.
 *
 * The dashboard browser talks ONLY to hive's own origin (same-origin `/api/*` and
 * `/setup/*`). hive's SERVER resolves the daemon that owns each request from doctor's
 * registry, then fetches that daemon over loopback and streams the response straight back.
 * This replaces the earlier client-side federation (the browser fetching each workload
 * daemon's origin directly via `/api/daemon-bases`), which required the workload daemons to
 * emit CORS headers and exposed their ports to a browser context.
 *
 * Auth model: TRANSPARENT PASS-THROUGH. hive forwards the browser's own request headers
 * (session headers + any auth) verbatim to the workload daemon; it stores no credential of its
 * own. This preserves honeycomb's existing loopback + local-mode + session-header posture and
 * keeps team/hybrid auth working without hive becoming an auth authority.
 *
 * SECURITY (SSRF): the daemon base is resolved through {@link resolveDaemonBases}, which drops
 * any non-loopback `healthUrl` from the registry and only ever hands back loopback origins. The
 * proxy re-checks the resolved base with {@link isLoopbackBaseUrl} (defense in depth) and pins
 * `redirect: "error"` so a workload daemon cannot 3xx-redirect the proxied fetch to an
 * off-loopback origin after the initial URL passed the loopback gate.
 */

import type { Context } from "hono";

import { isLoopbackBaseUrl, resolveEndpointOwner, type DaemonName } from "../shared/daemon-routing.js";
import { resolveDaemonBases } from "./registry.js";

/** The injectable fetch surface (the global in prod; a mock in unit tests). */
export type ProxyFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CreateApiProxyOptions {
  /** Override the doctor registry file path the daemon bases are resolved from. */
  readonly registryPath?: string;
  /** The fetch implementation used to reach the workload daemon (defaults to the global `fetch`). */
  readonly fetchImpl?: ProxyFetch;
}

/**
 * Request headers that must NOT be forwarded to the upstream daemon. `host` is dropped so fetch
 * sets it from the target origin; the rest are hop-by-hop headers (RFC 7230 §6.1) that are
 * meaningless across a proxy, plus `content-length` which fetch recomputes from the forwarded body.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length"
]);

/**
 * Response headers that must NOT be forwarded back to the browser. Hop-by-hop headers plus the
 * framing headers fetch has already resolved: `content-encoding`/`content-length` would be wrong
 * because fetch decompresses the upstream body before we re-stream it.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length"
]);

/** The fail-soft result for an unreachable/failed upstream: a non-2xx JSON body the wire degrades to empty. */
function unreachableResponse(daemon: DaemonName): Response {
  return new Response(JSON.stringify({ error: "unreachable", daemon }), {
    status: 502,
    headers: { "content-type": "application/json" }
  });
}

function forwardRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

function forwardResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

/**
 * Build the same-origin API proxy handler. Register it on hive's Hono app for `/api/*` and
 * `/setup/*` (AFTER the hive-owned routes like `/health` and `/api/fleet-status`, so those
 * win). It resolves the owning daemon per request, forwards method + headers + body over
 * loopback, and streams the upstream response back. Any failure (network error, non-loopback
 * base, redirect) degrades to a fail-soft 502 so one daemon being down never blanks the page.
 */
export function createApiProxy(options: CreateApiProxyOptions = {}) {
  const fetchImpl = options.fetchImpl ?? (fetch as ProxyFetch);

  return async (c: Context): Promise<Response> => {
    const incoming = c.req.raw;
    const requestUrl = new URL(incoming.url);
    const endpointPath = requestUrl.pathname;
    const owner = resolveEndpointOwner(endpointPath);

    const base = resolveDaemonBases({ registryPath: options.registryPath })[owner];
    // resolveDaemonBases only ever returns loopback origins; this re-check is defense in depth so a
    // future change to base resolution can never turn the proxy into an off-loopback SSRF primitive.
    if (!isLoopbackBaseUrl(base)) return unreachableResponse(owner);

    const target = `${base}${endpointPath}${requestUrl.search}`;
    const method = incoming.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    // Buffer the (small, JSON) request body rather than streaming it, so no `duplex: "half"` dance
    // is needed. GET/HEAD carry no body. The response body is streamed through (below) so SSE tails
    // and large payloads are not buffered.
    const body = hasBody ? await incoming.arrayBuffer() : undefined;

    try {
      const upstream = await fetchImpl(target, {
        method,
        headers: forwardRequestHeaders(incoming.headers),
        ...(body !== undefined ? { body } : {}),
        redirect: "error"
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardResponseHeaders(upstream.headers)
      });
    } catch {
      // Network error, refused connection, or a blocked redirect: fail soft per daemon.
      return unreachableResponse(owner);
    }
  };
}
