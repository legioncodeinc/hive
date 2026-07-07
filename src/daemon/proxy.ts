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
import {
  CACHEABLE_PATHS,
  computeCacheKey,
  createInMemoryProxyCache,
  isHardExcluded,
  resolveWriteInvalidations,
  type ProxyCache
} from "./proxy-cache.js";
import { resolveDaemonBases } from "./registry.js";

/** The injectable fetch surface (the global in prod; a mock in unit tests). */
export type ProxyFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CreateApiProxyOptions {
  /** Override the doctor registry file the daemon bases are resolved from. */
  readonly registryPath?: string;
  /** The fetch implementation used to reach the workload daemon (defaults to the global `fetch`). */
  readonly fetchImpl?: ProxyFetch;
  /** PRD-012a: the read cache. Defaults to a real in-memory impl; tests inject a fake + clock. */
  readonly cache?: ProxyCache;
  /** The clock used to test cache freshness (defaults to `Date.now`; tests inject a controllable clock). */
  readonly now?: () => number;
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
 * Tag every proxied response with its cache disposition so the client (and a debug overlay) can
 * observe cache behavior (PRD-012a). BYPASS = non-cacheable path, non-GET, or hard-excluded.
 */
const X_HIVE_CACHE = "x-hive-cache";
type CacheDisposition = "HIT" | "MISS" | "BYPASS";

/** Stamp `X-Hive-Cache` onto a copy of `res` (the cached/stripped response) without mutating it. */
function withCacheHeader(res: Response, disposition: CacheDisposition): Response {
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: withHeader(forwardResponseHeaders(res.headers), X_HIVE_CACHE, disposition)
  });
}

/** Append one header to a Headers copy (leaves the source untouched). */
function withHeader(source: Headers, key: string, value: string): Headers {
  const headers = new Headers(source);
  headers.set(key, value);
  return headers;
}

/**
 * Build the same-origin API proxy handler. Register it on hive's Hono app for `/api/*` and
 * `/setup/*` (AFTER the hive-owned routes like `/health` and `/api/fleet-status`, so those
 * win). It resolves the owning daemon per request, forwards method + headers + body over
 * loopback, and streams the upstream response back. Any failure (network error, non-loopback
 * base, redirect) degrades to a fail-soft 502 so one daemon being down never blanks the page.
 *
 * PRD-012a: GET reads on a closed allowlist of read-model endpoints are served from an
 * in-memory TTL cache (HIT short-circuits the loopback leg; MISS refetches). Non-GET 2xx
 * responses invalidate the affected owner+prefix entries before the response is returned.
 * Hard-excluded paths (`POST /api/memories/recall`, the SSE tails, `/setup/*`, `/api/memories/:id`)
 * bypass entirely. Every response carries `X-Hive-Cache: HIT|MISS|BYPASS`.
 */
export function createApiProxy(options: CreateApiProxyOptions = {}) {
  const fetchImpl = options.fetchImpl ?? (fetch as ProxyFetch);
  const now = options.now ?? Date.now;
  const cache = options.cache ?? createInMemoryProxyCache({ now });

  return async (c: Context): Promise<Response> => {
    const incoming = c.req.raw;
    const requestUrl = new URL(incoming.url);
    const endpointPath = requestUrl.pathname;
    const search = requestUrl.search;
    const owner = resolveEndpointOwner(endpointPath);
    const method = incoming.method;
    const projectHeader = incoming.headers.get("x-honeycomb-project") ?? "";

    const base = resolveDaemonBases({ registryPath: options.registryPath })[owner];
    // resolveDaemonBases only ever returns loopback origins; this re-check is defense in depth so a
    // future change to base resolution can never turn the proxy into an off-loopback SSRF primitive.
    // The cache never sees a non-loopback base: the 502 fail-soft below returns before any lookup.
    if (!isLoopbackBaseUrl(base)) return unreachableResponse(owner);

    // Hard-excluded requests and non-cacheable paths bypass the cache entirely (fail-safe).
    const cacheable = method === "GET" && !isHardExcluded(method, endpointPath) && CACHEABLE_PATHS.has(endpointPath);

    // --- Write / bypass path ---------------------------------------------------------------
    // PRD-012a: BYPASS = non-cacheable path or non-GET. Hard-excluded requests also bypass.
    if (!cacheable) {
      const response = await fetchUpstream(fetchImpl, base, incoming, endpointPath, search, method);
      if (response === null) return withCacheHeader(unreachableResponse(owner), "BYPASS");
      // After a successful mutating write (non-GET, 2xx, NOT hard-excluded), invalidate the affected
      // owner+prefix entries BEFORE returning, so the immediately-following read reflects the write.
      // Hard-excluded methods (e.g. POST /api/memories/recall) do NOT invalidate (they bypass).
      if (response.ok && method !== "GET" && !isHardExcluded(method, endpointPath)) {
        for (const { owner: invOwner, prefix } of resolveWriteInvalidations(method, owner, endpointPath)) {
          cache.deleteByPrefix(invOwner, prefix);
        }
      }
      return withCacheHeader(response, "BYPASS");
    }

    // --- GET cacheable path ---------------------------------------------------------------
    const key = computeCacheKey(method, owner, endpointPath, search, projectHeader);
    const entry = cache.get(key);

    // HIT — fresh entry within TTL: clone and serve without crossing loopback.
    if (entry !== undefined && entry.kind === "fresh" && now() < entry.expiresAt) {
      return withCacheHeader(entry.response.clone(), "HIT");
    }

    // HIT — inflight coalescing: await the same fetch promise another request started.
    if (entry !== undefined && entry.kind === "inflight") {
      try {
        const upstream = await entry.promise;
        return withCacheHeader(upstream.clone(), "HIT");
      } catch {
        // The original fetch failed; it has already cleared the inflight entry. Degrade to 502.
        return withCacheHeader(unreachableResponse(owner), "MISS");
      }
    }

    // MISS — start the fetch, store the inflight promise so concurrent identical GETs coalesce.
    // The stored promise resolves to a Response (rejects on failure) so coalesced awaiters can await
    // the same promise and clone its resolution, or degrade to 502 MISS on rejection.
    const fetchPromise = (async (): Promise<Response> => {
      const upstream = await fetchUpstream(fetchImpl, base, incoming, endpointPath, search, method);
      if (upstream === null) throw new Error("upstream unreachable");
      return upstream;
    })();
    cache.setInflight(key, fetchPromise);

    try {
      const upstream = await fetchPromise;
      // Store a CLONE for the cache (so it survives future reads); return a separate clone. A
      // Response body can be consumed only once, so the cached copy and the served copy are distinct.
      const ttlMs = CACHEABLE_PATHS.get(endpointPath);
      if (ttlMs !== undefined) cache.set(key, upstream.clone(), ttlMs);
      return withCacheHeader(upstream.clone(), "MISS");
    } catch {
      // Network error, refused connection, or a blocked redirect: do NOT cache the failure; clear
      // the inflight entry so the next request retries rather than awaiting a dead promise.
      cache.delete(key);
      return withCacheHeader(unreachableResponse(owner), "MISS");
    }
  };
}

/**
 * Forward a request to the upstream daemon over loopback. Returns the upstream `Response` (to be
 * re-wrapped by the caller), or `null` when the fetch threw (network error / blocked redirect) so
 * the caller can apply the fail-soft 502. The `redirect: "error"` pin is preserved so a workload
 * daemon cannot 3xx-redirect the proxied fetch off-loopback.
 */
async function fetchUpstream(
  fetchImpl: ProxyFetch,
  base: string,
  incoming: Request,
  endpointPath: string,
  search: string,
  method: string
): Promise<Response | null> {
  const target = `${base}${endpointPath}${search}`;
  const hasBody = method !== "GET" && method !== "HEAD";
  // Buffer the (small, JSON) request body rather than streaming it, so no `duplex: "half"` dance
  // is needed. GET/HEAD carry no body. The response body is streamed through (below) so SSE tails
  // and large payloads are not buffered.
  const body = hasBody ? await incoming.arrayBuffer() : undefined;
  try {
    return await fetchImpl(target, {
      method,
      headers: forwardRequestHeaders(incoming.headers),
      ...(body !== undefined ? { body } : {}),
      redirect: "error"
    });
  } catch {
    // Network error, refused connection, or a blocked redirect: fail soft per daemon.
    return null;
  }
}
