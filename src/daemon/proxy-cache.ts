/**
 * PRD-012a: the server-side BFF proxy read cache.
 *
 * An in-memory TTL cache for GET reads on a closed allowlist of dashboard read-model endpoints,
 * living inside {@link createApiProxy} (`./proxy.ts`). The cache is keyed by
 * `${method}:${owner}:${pathname}:${search}:${projectHeader}` so two projects' reads never collide.
 * `POST /api/memories/recall`, the SSE tails, every `/setup/*` and `/api/onboarding/*`, and every
 * non-allowlisted path bypass entirely.
 *
 * Design (see `library/requirements/in-work/prd-012-dashboard-caching-layer/prd-012a-bff-proxy-read-cache.md`):
 * - Fail-soft: a miss/stale entry degrades to the exact behavior today's proxy has (a refetch).
 * - Transparent to the contract: no endpoint shape change; the cached body is the raw Response,
 *   cloned on read (a Response body can be consumed only once).
 * - Coalescing: an inflight fetch is stored as a `Promise<Response>`; a second concurrent GET for
 *   the same key awaits the same promise (one loopback fetch).
 * - Bounded: at most `maxEntries` (default 256); on overflow the nearest-to-expire fresh entry is
 *   evicted (simplest correct policy for a TTL cache; no LRU bookkeeping).
 */

import type { DaemonName } from "../shared/daemon-routing.js";

/** A cached entry: either a fresh response with an expiry, or an inflight fetch promise. */
export type CacheEntry =
  | { readonly kind: "fresh"; readonly response: Response; readonly expiresAt: number }
  | { readonly kind: "inflight"; readonly promise: Promise<Response> };

/**
 * The cache surface {@link createApiProxy} consumes. The default in-memory implementation is
 * {@link createInMemoryProxyCache}; tests inject a fake.
 */
export interface ProxyCache {
  /**
   * Returns the entry for `key`, or `undefined` when absent. A `fresh` entry past its `expiresAt`
   * is treated as absent (the in-memory impl lazily drops it). The caller distinguishes `fresh`
   * from `inflight` via `kind`.
   */
  get(key: string): CacheEntry | undefined;
  /**
   * Store a fresh response. `ttlMs` is the per-call TTL; the cache computes
   * `expiresAt = now() + ttlMs` using its injected clock.
   */
  set(key: string, response: Response, ttlMs: number): void;
  /** Store an inflight fetch promise so a concurrent identical GET coalesces onto it. */
  setInflight(key: string, promise: Promise<Response>): void;
  /** Remove a single entry (used to clear a failed inflight so the next request retries). */
  delete(key: string): void;
  /**
   * Invalidate every entry whose owner is `owner` and whose pathname starts with `prefix`.
   * Used by the write-invalidation path after a successful mutating request.
   */
  deleteByPrefix(owner: DaemonName, prefix: string): void;
  /** Remove every entry. */
  clear(): void;
  /** The current number of stored entries (fresh + inflight). */
  readonly size: number;
}

export interface CreateInMemoryProxyCacheOptions {
  /** The clock used to compute `expiresAt` and to test freshness. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The maximum number of entries before nearest-to-expire eviction kicks in. Defaults to 256. */
  readonly maxEntries?: number;
}

/** Default capacity: generous for a single-operator dashboard; prevents unbounded growth. */
const DEFAULT_MAX_ENTRIES = 256;

/**
 * The default in-memory {@link ProxyCache}: a `Map<string, CacheEntry>` with wall-clock TTL,
 * inflight coalescing, nearest-to-expire-first eviction, and owner-scoped prefix invalidation.
 */
export function createInMemoryProxyCache(
  options: CreateInMemoryProxyCacheOptions = {}
): ProxyCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const map = new Map<string, CacheEntry>();

  function evictNearestToExpire(): void {
    let minKey: string | undefined;
    let minExpires = Infinity;
    for (const [key, entry] of map) {
      if (entry.kind === "fresh" && entry.expiresAt < minExpires) {
        minExpires = entry.expiresAt;
        minKey = key;
      }
    }
    // If every entry is inflight (no fresh expiresAt to compare), there is no TTL basis to evict
    // on; allow this one insert to briefly exceed the cap rather than drop a live coalescing probe.
    if (minKey !== undefined) map.delete(minKey);
  }

  return {
    get(key: string): CacheEntry | undefined {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (entry.kind === "fresh" && now() >= entry.expiresAt) {
        // Stale: drop lazily so the next read is a clean miss.
        map.delete(key);
        return undefined;
      }
      return entry;
    },
    set(key: string, response: Response, ttlMs: number): void {
      if (!map.has(key) && map.size >= maxEntries) evictNearestToExpire();
      map.set(key, { kind: "fresh", response, expiresAt: now() + ttlMs });
    },
    setInflight(key: string, promise: Promise<Response>): void {
      // The proxy always sets an inflight entry before the fresh one resolves onto the same key, so
      // the eventual `set` would never see a new key (and thus never evict). Enforce the cap here too
      // so the cache stays bounded through the inflight→fresh transition.
      if (!map.has(key) && map.size >= maxEntries) evictNearestToExpire();
      map.set(key, { kind: "inflight", promise });
    },
    delete(key: string): void {
      map.delete(key);
    },
    deleteByPrefix(owner: DaemonName, prefix: string): void {
      // key = `${method}:${owner}:${pathname}:${search}:${projectHeader}`. The owner+pathname start
      // AFTER the leading `${method}:` segment, so skip it and match `${owner}:${prefix}` at the
      // start of the remainder. A `prefix` of `""` therefore matches every entry for `owner`
      // (the org-switch "invalidate ALL" case).
      const token = `${owner}:${prefix}`;
      for (const key of [...map.keys()]) {
        const firstColon = key.indexOf(":");
        const rest = firstColon === -1 ? key : key.slice(firstColon + 1);
        if (rest.startsWith(token)) map.delete(key);
      }
    },
    clear(): void {
      map.clear();
    },
    get size(): number {
      return map.size;
    }
  };
}

/**
 * The closed allowlist of cacheable GET pathnames → TTL (ms). EXACT-match only: `/api/logs` is
 * cached but `/api/logs/stream` and `/api/logs/history` are not; `/api/memories` (the LIST) is
 * cached but `/api/memories/:id` is hard-excluded. TTLs: 2 s (hot/polled), 5 s (composite),
 * 30 s (static-ish). Source: PRD-012a "Path allowlist".
 */
export const CACHEABLE_PATHS: ReadonlyMap<string, number> = new Map<string, number>([
  // 2 s — hot read models, polled on dashboard mount.
  ["/api/diagnostics/kpis", 2_000],
  ["/api/diagnostics/sessions", 2_000],
  ["/api/diagnostics/harnesses", 2_000],
  ["/api/status", 2_000],
  ["/api/memories", 2_000], // exact: the LIST, NOT /:id
  ["/api/logs", 2_000], // exact: the ring-buffer snapshot, NOT /stream or /history
  ["/api/hive-graph/status", 2_000],
  // 5 s — composite / derived view-models.
  ["/api/diagnostics/assets", 5_000],
  ["/api/diagnostics/roi", 5_000],
  ["/api/diagnostics/roi/trend", 5_000],
  ["/api/diagnostics/memory-graph", 5_000],
  ["/api/graph", 5_000],
  ["/api/hive-graph/projection", 5_000],
  ["/api/hive-graph/projects", 5_000],
  // 30 s — static-ish surfaces.
  ["/api/diagnostics/settings", 30_000],
  ["/api/diagnostics/rules", 30_000],
  ["/api/diagnostics/skills", 30_000],
  ["/api/diagnostics/scope/orgs", 30_000],
  ["/api/diagnostics/scope/workspaces", 30_000],
  ["/api/diagnostics/scope/projects", 30_000],
  ["/api/settings", 30_000],
  ["/api/secrets", 30_000],
  ["/api/auth/status", 30_000]
]);

/** A single invalidation target: bust every entry for `owner` whose pathname starts with `prefix`. */
export interface InvalidationTarget {
  readonly owner: DaemonName;
  readonly prefix: string;
}

/** One row of the explicit write-invalidation table: a method + path regex → targets to bust. */
export interface WriteInvalidationRule {
  readonly method: string;
  readonly pathPattern: RegExp;
  readonly invalidate: ReadonlyArray<InvalidationTarget>;
}

/**
 * The explicit write-invalidation map (PRD-012a "Write invalidation map"). Each row matches a
 * non-GET method + path regex and lists the owner+prefixes to invalidate after a 2xx response.
 * `POST /api/actions/restart` invalidates nothing (the daemon is restarting; the cache misses
 * naturally on the next read). Rows are matched in order; the first match wins. A non-GET that
 * matches NO row falls back to the conservative same-owner broad-prefix default
 * (see {@link resolveWriteInvalidations}).
 */
export const WRITE_INVALIDATIONS: ReadonlyArray<WriteInvalidationRule> = [
  {
    method: "POST",
    pathPattern: /^\/api\/memories$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/memories\/[^/]+\/modify$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/memories\/[^/]+\/forget$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/diagnostics\/compact$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/diagnostics\/pollinate$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/diagnostics/skills" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" },
      { owner: "honeycomb", prefix: "/api/diagnostics/assets" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/diagnostics\/sync\/(promote|pull|demote|enable|disable)$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/diagnostics/skills" },
      { owner: "honeycomb", prefix: "/api/diagnostics/assets" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/actions\/logout$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/auth/status" },
      { owner: "honeycomb", prefix: "/api/settings" },
      { owner: "honeycomb", prefix: "/api/secrets" },
      { owner: "honeycomb", prefix: "/api/status" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" },
      { owner: "honeycomb", prefix: "/api/diagnostics/sessions" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/actions\/embeddings$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/status" },
      { owner: "honeycomb", prefix: "/api/diagnostics/settings" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/actions\/memory$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/status" },
      { owner: "honeycomb", prefix: "/api/diagnostics/settings" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/actions\/restart$/,
    invalidate: [] // no invalidation — the daemon is restarting; the cache misses naturally.
  },
  {
    method: "POST",
    pathPattern: /^\/api\/graph\/build$/,
    invalidate: [{ owner: "honeycomb", prefix: "/api/graph" }]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/hive-graph\/build$/,
    invalidate: [
      { owner: "nectar", prefix: "/api/hive-graph/status" },
      { owner: "nectar", prefix: "/api/hive-graph/projection" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/hive-graph\/projects\/brooding$/,
    invalidate: [
      { owner: "nectar", prefix: "/api/hive-graph/projects" },
      { owner: "nectar", prefix: "/api/hive-graph/status" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/diagnostics\/scope\/org-switch$/,
    invalidate: [{ owner: "honeycomb", prefix: "" }] // ALL honeycomb entries (token re-minted).
  },
  {
    method: "POST",
    pathPattern: /^\/api\/diagnostics\/scope\/workspace-switch$/,
    invalidate: [
      { owner: "honeycomb", prefix: "/api/diagnostics/scope/projects" },
      { owner: "honeycomb", prefix: "/api/diagnostics/kpis" },
      { owner: "honeycomb", prefix: "/api/diagnostics/sessions" },
      { owner: "honeycomb", prefix: "/api/memories" },
      { owner: "honeycomb", prefix: "/api/graph" }
    ]
  },
  {
    method: "POST",
    pathPattern: /^\/api\/diagnostics\/projects\/(bind|bind-existing|unbind)$/,
    invalidate: [{ owner: "honeycomb", prefix: "/api/diagnostics/scope/projects" }]
  }
];

/** The conservative default broad-prefix for an unmatched non-GET: `/${seg1}/${seg2}`. */
export function defaultInvalidatePrefix(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length >= 2) return `/${segs[0]}/${segs[1]}`;
  if (segs.length === 1) return `/${segs[0]}`;
  return "/";
}

/**
 * Resolve the invalidation targets for a non-GET request. Returns the first matching explicit
 * rule's targets (possibly empty, e.g. `/api/actions/restart`); if no rule matches, returns the
 * conservative same-owner broad-prefix default. Only invoked after a 2xx upstream response.
 */
export function resolveWriteInvalidations(
  method: string,
  owner: DaemonName,
  pathname: string
): ReadonlyArray<InvalidationTarget> {
  for (const rule of WRITE_INVALIDATIONS) {
    if (rule.method === method && rule.pathPattern.test(pathname)) return rule.invalidate;
  }
  return [{ owner, prefix: defaultInvalidatePrefix(pathname) }];
}

/**
 * Compute the cache key: `${method}:${owner}:${pathname}:${search}:${projectHeader}`.
 * `search` includes the leading `?` when non-empty (verbatim from `URL.search`), else `""`.
 * `projectHeader` is the raw `x-honeycomb-project` header value or `""`. Partitioning by owner
 * and project prevents cross-daemon and cross-project collisions.
 */
export function computeCacheKey(
  method: string,
  owner: DaemonName,
  pathname: string,
  search: string,
  projectHeader: string
): string {
  return `${method}:${owner}:${pathname}:${search}:${projectHeader}`;
}

/**
 * Hard-excluded requests are never cached and never invalidate — they bypass entirely:
 * `POST /api/memories/recall` (per-query compute), the SSE tails (`/api/logs/stream`,
 * `/api/logs/history`, `/api/telemetry/stream`), every `/setup/*` and `/api/onboarding/*`
 * (auth/onboarding flow), and `GET /api/memories/:id` (single-memory detail; the list is cached).
 */
export function isHardExcluded(method: string, pathname: string): boolean {
  if (method === "POST" && pathname === "/api/memories/recall") return true;
  if (pathname === "/setup" || pathname.startsWith("/setup/")) return true;
  if (pathname === "/api/logs/stream" || pathname === "/api/logs/history") return true;
  if (pathname === "/api/telemetry/stream") return true;
  if (pathname === "/api/onboarding" || pathname.startsWith("/api/onboarding/")) return true;
  // GET single-memory detail (path deeper than the list). The list (`/api/memories` exact) is cacheable.
  if (method === "GET" && pathname.startsWith("/api/memories/")) return true;
  return false;
}
