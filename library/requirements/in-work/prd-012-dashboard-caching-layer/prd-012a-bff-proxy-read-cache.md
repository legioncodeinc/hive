# PRD-012a: Server-side BFF proxy read cache

> **Parent:** [`prd-012-dashboard-caching-layer`](./prd-012-dashboard-caching-layer-index.md)
> **Status:** Draft
> **Effort:** M (3-8h)

---

## Overview

`createApiProxy` (`src/daemon/proxy.ts:105-144`) is today a pure pass-through: every `/api/*` and `/setup/*` request resolves its owning daemon, fetches it over loopback, and streams the response back with no caching whatsoever. The operator feels this as latency on every route switch and remount, because the same `kpis`/`sessions`/`harnesses`/`graph` bodies get re-fetched from honeycomb/nectar dozens of times per session despite being byte-identical within seconds.

This sub-PRD adds an **in-memory TTL cache inside the proxy** for GET reads on a closed allowlist of read-model endpoints. The cache is keyed by `${method}:${owner}:${pathname}:${search}:${projectHeader}`, populated on a miss, served on a hit, and invalidated by writes (POST/PUT/DELETE) on a per-owner+path-prefix basis. POST `/api/memories/recall`, every `/setup/*` read, the SSE streams, and every non-allowlisted path bypass the cache entirely.

The proxy's existing contract — loopback-only (`isLoopbackBaseUrl`), redirect-pinned (`redirect: "error"`), transparent auth pass-through, fail-soft 502 — is unchanged. The cache is an internal optimization; a HIT short-circuits the loopback leg, a MISS behaves exactly as today.

---

## Goals

- A repeated GET to a cached read endpoint within its TTL is served from the in-memory cache without crossing loopback to the owning daemon.
- Two concurrent identical GETs coalesce into one loopback fetch (the second awaits the first's promise, not a second fetch).
- A write to a mutating endpoint invalidates the affected cache entries synchronously in the same request, before the response is returned to the browser, so the immediately-following read reflects the write.
- The `x-honeycomb-project` request header and the nectar `?project=` query are part of the cache key; two projects' reads never collide.
- The cache never serves a response whose original fetch was non-loopback or hit the redirect-pin.

## Non-Goals

- Persistent/on-disk caching (in-memory, per-process only).
- Distributed cache / multi-instance coordination (hive is single-instance by PID/lock).
- Caching POST/`/recall`/SSE/`/setup/*` (hard-excluded).
- ETag / `If-None-Match` / 304 negotiation (the in-memory TTL cache makes this unnecessary for v1; a future sub-PRD may add it for cross-process freshness).
- Changing any endpoint's shape, zod schema, or response body.
- Caching hive-owned routes (`/health`, `/api/fleet-status`, `/api/registered-services`, `/api/telemetry/stream`, `/api/onboarding/*`).

---

## Cache key shape

```
key = `${method}:${owner}:${pathname}:${search}:${projectHeader}`
```

- `method` — the HTTP method. Only `GET` is ever cached; everything else is a write (invalidates) or a bypass.
- `owner` — the resolved `DaemonName` from `resolveEndpointOwner(pathname)` (`src/shared/daemon-routing.ts:11`). Always `honeycomb` or `nectar`. Partitioning by owner prevents any cross-daemon collision and makes invalidation scoped.
- `pathname` — the request's pathname (no search). Cached as-is.
- `search` — the raw `?…` search string, verbatim. Required because nectar `?project=` scopes reads (`wire.ts:182`) and `?limit=` paginates (`/api/memories?limit=50`).
- `projectHeader` — the value of the `x-honeycomb-project` request header (`wire.ts:174`), or `""` when absent. Required because honeycomb narrows reads by this header (`resolveRequestProject`); two projects' `/api/diagnostics/kpis` reads must not collide.

The key is computed once per request from `requestUrl` + the forwarded request headers. It is opaque outside the cache module.

---

## Path allowlist (what is cacheable)

Only GET requests to these pathname prefixes are eligible for caching. Everything else bypasses.

| Owner | Pathname (or prefix) | TTL (default) | Why |
|---|---|---|---|
| honeycomb | `/api/diagnostics/kpis` | 2 s | Hot KPI band; polled on dashboard mount |
| honeycomb | `/api/diagnostics/sessions` | 2 s | Turns list; polled |
| honeycomb | `/api/diagnostics/settings` | 30 s | Rarely changes; the org/workspace identity read |
| honeycomb | `/api/diagnostics/rules` | 30 s | Rule list; static-ish |
| honeycomb | `/api/diagnostics/skills` | 30 s | Skill list; changes on sync |
| honeycomb | `/api/diagnostics/harnesses` | 2 s | Harness registry + last-seen; polled |
| honeycomb | `/api/diagnostics/assets` | 5 s | Sync union view-model |
| honeycomb | `/api/diagnostics/roi` | 5 s | ROI composite |
| honeycomb | `/api/diagnostics/roi/trend` | 5 s | ROI trend series |
| honeycomb | `/api/diagnostics/memory-graph` | 5 s | Memory-graph view-model |
| honeycomb | `/api/diagnostics/scope/orgs` | 30 s | Scope-switcher enumeration |
| honeycomb | `/api/diagnostics/scope/workspaces` | 30 s | Scope-switcher enumeration |
| honeycomb | `/api/diagnostics/scope/projects` | 30 s | Scope-switcher enumeration |
| honeycomb | `/api/graph` | 5 s | Codebase graph snapshot |
| honeycomb | `/api/memories` (exact, the LIST) | 2 s | `GET /api/memories?limit=N` — the memories list, NOT the `/:id` detail |
| honeycomb | `/api/settings` | 30 s | Vault `setting`-class surface + catalog |
| honeycomb | `/api/secrets` | 30 s | Names-only presence surface |
| honeycomb | `/api/auth/status` | 30 s | Redacted auth-status read-model |
| honeycomb | `/api/status` | 2 s | honeycomb per-subsystem reasons; polled by settings |
| honeycomb | `/api/logs` (exact snapshot) | 2 s | `GET /api/logs` — the ring-buffer snapshot, NOT `/stream` or `/history` |
| nectar | `/api/hive-graph/status` | 2 s | Hive-graph queue/cost widgets; polled |
| nectar | `/api/hive-graph/projection` | 5 s | Hive-graph projection read |
| nectar | `/api/hive-graph/projects` | 5 s | Nectar projects panel |

**Hard-excluded (never cached, always fresh):**

- `POST /api/memories/recall` — per-query compute; bypass.
- `GET /api/logs/stream`, `GET /api/logs/history` — SSE tail and paginated history; bypass (history is paginated + cursor-bound and would balloon the cache).
- `GET /api/memories/:id` (path depth > 2 under `/api/memories/`) — single-memory detail; the invalidation-on-write complexity isn't worth it for v1, and `memories.tsx` already re-reads after a write. Revisit in a future sub-PRD.
- Every `/setup/*` path — auth/onboarding flow; always fresh.
- Every `/api/onboarding/*` path — installer SSE + state; hive-owned and already `no-store`.
- `/api/telemetry/stream` — SSE; hive-owned.
- Anything not in the allowlist above — bypass (fail-safe default).

The allowlist is a single `Map<string, number>` (path → TTL) consulted in `createApiProxy`. Adding/removing a cacheable path is a one-line change.

---

## Write invalidation map

A write (any non-GET method that is not hard-excluded) invalidates by **owner + path-prefix** before the response is returned. The map is deliberately broad-prefix (see parent open question): a write to one memory invalidates the whole memories family plus the derived KPI count, rather than risk serving a stale derived value.

| Write (method + path) | Invalidate (owner + prefix) |
|---|---|
| `POST /api/memories` (store) | honeycomb: `/api/memories`, `/api/diagnostics/kpis` |
| `POST /api/memories/:id/modify` | honeycomb: `/api/memories`, `/api/diagnostics/kpis` |
| `POST /api/memories/:id/forget` | honeycomb: `/api/memories`, `/api/diagnostics/kpis` |
| `POST /api/diagnostics/compact` | honeycomb: `/api/memories`, `/api/diagnostics/kpis` |
| `POST /api/diagnostics/pollinate` | honeycomb: `/api/diagnostics/skills`, `/api/diagnostics/kpis`, `/api/diagnostics/assets` |
| `POST /api/diagnostics/sync/{promote,pull,demote,enable,disable}` | honeycomb: `/api/diagnostics/skills`, `/api/diagnostics/assets`, `/api/diagnostics/kpis` |
| `POST /api/actions/logout` | honeycomb: `/api/auth/status`, `/api/settings`, `/api/secrets`, `/api/status`, `/api/diagnostics/kpis`, `/api/diagnostics/sessions` (logout changes the connected + identity state broadly) |
| `POST /api/actions/embeddings` | honeycomb: `/api/status`, `/api/diagnostics/settings` |
| `POST /api/actions/memory` | honeycomb: `/api/status`, `/api/diagnostics/settings` |
| `POST /api/actions/restart` | (no invalidation — the daemon is restarting; the cache will naturally miss on the next read) |
| `POST /api/graph/build` | honeycomb: `/api/graph` |
| `POST /api/hive-graph/build` | nectar: `/api/hive-graph/status`, `/api/hive-graph/projection` |
| `POST /api/hive-graph/projects/brooding` | nectar: `/api/hive-graph/projects`, `/api/hive-graph/status` |
| `POST /api/diagnostics/scope/org-switch` | honeycomb: ALL (an org switch re-mints the token; every scoped read is potentially different) |
| `POST /api/diagnostics/scope/workspace-switch` | honeycomb: `/api/diagnostics/scope/projects`, `/api/diagnostics/kpis`, `/api/diagnostics/sessions`, `/api/memories`, `/api/graph` |
| `POST /api/diagnostics/projects/{bind,bind-existing,unbind}` | honeycomb: `/api/diagnostics/scope/projects` |
| Any other non-GET not in this table | honeycomb or nectar: same-owner `/${first-path-segment}/${second-path-segment}` prefix (conservative broad-prefix default) |

Invalidation is a synchronous `cache.deleteByPrefix(owner, prefix)` loop executed **after** the upstream write succeeds (2xx) and **before** the response is returned to the browser. A non-2xx write response does NOT invalidate (the write failed; the cache is still valid).

---

## Behavior in the proxy handler

The modified `createApiProxy` flow (pseudocode — the real shape stays a single handler returning `Response`):

```
incoming → resolve owner + base + loopback guard (unchanged)
         → if method !== GET OR path not in allowlist:
              → it's a write or a bypass: fetch upstream (unchanged), stream back,
                THEN if 2xx + method is a known mutator: invalidate(prefixes) before return
         → else (GET + cacheable):
              → key = computeKey(method, owner, pathname, search, projectHeader)
              → entry = cache.get(key)
              → if entry && fresh: return clone(entry.response), X-Hive-Cache: HIT
              → if entry && in-flight: await entry.inflight, return clone, X-Hive-Cache: HIT
              → else: start fetch → store inflight promise → on resolve: store {response, expiresAt},
                       clear inflight, return clone, X-Hive-Cache: MISS
```

Key implementation notes:

- **The cached `Response` is cloned on read** (`Response.clone()`). The original stays in the cache; the clone is returned to the browser. The body is consumed lazily by the browser as today.
- **Coalescing stores the inflight `Promise<Response>`, not its resolution.** A second concurrent GET for the same key awaits the same promise. On resolution, both callers get a clone. This is the single-loopback-fetch guarantee for concurrent identical reads.
- **TTL is wall-clock.** `expiresAt = Date.now() + ttlMs` on fill. A read after `expiresAt` is a MISS (the entry is dropped + refetched). No lazy revalidation on the server (the client SWR layer does background revalidate; the server cache is strict TTL).
- **`X-Hive-Cache` header.** Every proxied response carries `X-Hive-Cache: HIT|MISS|BYPASS` so the client (and a debug overlay) can observe cache behavior. BYPASS = the path is non-cacheable or the method is non-GET.
- **Cache size bound.** The cache holds at most N entries (default 256). On overflow, evict the entry with the nearest `expiresAt` (simplest correct policy for a TTL cache; no LRU bookkeeping). N is generous for a single-operator dashboard and prevents unbounded growth from a paginated-query flood.
- **No `Cache-Control` is added to proxied responses in v1.** The browser HTTP cache is a separate layer (parent open question); the in-memory proxy cache does not require it. A future sub-PRD may add `Cache-Control: private, max-age=2, stale-while-revalidate=10` to cacheable reads, but v1 keeps the response headers identical to today (minus the new `X-Hive-Cache` debug header).

---

## Security and correctness guards (carry forward from ADR-0002)

- **Loopback-only.** The cache stores responses keyed by `owner` (which is resolved from `resolveEndpointOwner`, a pure path function) and the request's `pathname`/`search`/`projectHeader`. The resolved `base` is re-checked with `isLoopbackBaseUrl` before any fetch; a non-loopback base returns the 502 fail-soft as today and never reaches the cache. A cache key never embeds the base URL — only the owner — so a registry change that flips an owner's base cannot cause a cross-origin cache hit (the key is the same; the value is refetched on the next MISS because the TTL is short).
- **Redirect-pin preserved.** The upstream fetch keeps `redirect: "error"`. A response that survived the fetch (i.e., did not throw on redirect) is cacheable; a redirect that threw never enters the cache (the catch returns the 502 fail-soft, uncached).
- **No auth in the key.** The cache key deliberately does NOT include the `Authorization` header or session headers. This is correct because (a) hive is single-operator local-mode by design, (b) the `projectHeader` is the only scoping dimension honeycomb honors for these reads, and (c) including auth in the key would create a privacy surface inside the cache. If/when hive supports team/hybrid multi-operator mode, this decision is revisited (see open question).
- **No body mutation.** The cached body is the raw `Response`; it is cloned, never parsed or rewritten. A malformed body from the upstream is cached as-is and served as-is (the client's zod `.catch()` handles it, exactly as today). On v1 there is no "validate before cache" step — the cache is transparent.

---

## Injectable seam for tests

The cache is injected into `createApiProxy` via an options field, mirroring the existing `fetchImpl` seam:

```ts
export interface ProxyCache {
  get(key: string): { response: Response; expiresAt: number } | { inflight: Promise<Response> } | undefined;
  set(key: string, response: Response, ttlMs: number): void;
  setInflight(key: string, promise: Promise<Response>): void;
  deleteByPrefix(owner: DaemonName, prefix: string): void;
  clear(): void;
}

export interface CreateApiProxyOptions {
  registryPath?: string;
  fetchImpl?: ProxyFetch;
  cache?: ProxyCache;          // ← new. defaults to a real in-memory impl
  now?: () => number;          // ← new. defaults to Date.now; tests inject a controllable clock
}
```

This lets `tests/daemon/proxy.test.ts` inject a fake cache + clock and assert HIT/MISS/invalidation without time-based flakiness. The existing tests (which pass no cache) get the real default and observe the same external behavior (the cache is transparent).

---

## Test plan

All in `tests/daemon/proxy.test.ts` (extend the existing `withRegistry` helper):

- **cache-hit:** one GET, then a second GET within TTL → `fetchImpl` is called exactly once; second response carries `X-Hive-Cache: HIT`; bodies are byte-identical.
- **cache-miss-after-ttl:** one GET, advance injected clock past TTL, second GET → `fetchImpl` called twice; second response carries `X-Hive-Cache: MISS`.
- **write-invalidates:** `POST /api/memories` (store) → subsequent `GET /api/memories?limit=50` within TTL is a MISS (refetched), and `GET /api/diagnostics/kpis` is also a MISS (derived count invalidated). A `POST /api/actions/restart` does NOT invalidate anything.
- **project-scoping-isolation:** `GET /api/diagnostics/kpis` with `x-honeycomb-project: A`, then the same with `: B` → two distinct `fetchImpl` calls; each project's body is served only to its own header. Swapping the header back to A within TTL serves A's cached body (HIT).
- **coalescing:** two concurrent identical GETs (same key) fired in the same tick → `fetchImpl` called exactly once; both responses resolve with the same body.
- **bypass-non-cacheable:** `POST /api/memories/recall` never reads or writes the cache; response carries `X-Hive-Cache: BYPASS`. `GET /api/telemetry/stream` likewise BYPASS.
- **loopback-guard:** with a registry entry whose `healthUrl` is non-loopback, the cache is never populated (the 502 fail-soft path bypasses the cache).
- **redirect-pin:** `fetchImpl` that returns a `Response` with `status: 302` and a `Location` to a non-loopback origin → the proxy's `redirect: "error"` rejects it; the catch returns 502; nothing enters the cache.
- **size-bound-eviction:** inject a cache with capacity 2, fill 3 distinct keys, assert the nearest-to-expire entry was evicted.
- **existing-suite-unchanged:** every existing test in `proxy.test.ts` passes without modification (the default cache is transparent; existing assertions on `fetchImpl` call counts are updated only where the test made multiple identical GETs that now coalesce).

---

## Files touched

### New files
- `src/daemon/proxy-cache.ts` — the `ProxyCache` interface, the in-memory implementation (Map + TTL + inflight coalescing + size bound), the path allowlist + TTL table, the write-invalidation map, and the `computeKey` helper.
- `tests/daemon/proxy-cache.test.ts` — unit tests for the cache itself (TTL, coalescing, invalidation, eviction), independent of the proxy handler.

### Modified files
- `src/daemon/proxy.ts` — `createApiProxy` consumes the cache: GET-cacheable → lookup/fill/coalesce; non-GET-2xx → invalidate; every response carries `X-Hive-Cache`. The handler's signature and return type are unchanged.
- `src/daemon/server.ts` — no change required (the cache defaults internally); optionally pass an explicit cache instance for testability from `createHive` if desired.
- `tests/daemon/proxy.test.ts` — extend with the new cases above; update existing cases that fire multiple identical GETs to assert coalescing rather than separate fetches.

---

## Open questions

- **Team/hybrid mode auth in the key.** Today hive is local-mode single-operator; excluding auth from the key is correct. If/when team/hybrid mode lets two operators share one hive origin, the key must gain a hash of the auth header (or the resolved principal) to prevent cross-operator cache leakage. Default for v1: document the assumption, gate team/hybrid on a follow-up.
- **`/api/logs` history cursor explosion.** `/api/logs/history` is paginated with a cursor (`wire.ts:691-697`); caching every cursor window would balloon the cache. v1 hard-excludes it. Revisit if the history table's most-recent-page read becomes a hot path.
- **Cache metrics / observability.** v1 ships only the `X-Hive-Cache` header. A future sub-PRD may add a `/api/diagnostics/cache-stats` read (hit rate, size, eviction count) if debugging demands it. Default: not in v1.

---

## Related

- [`prd-012-dashboard-caching-layer`](./prd-012-dashboard-caching-layer-index.md) — parent.
- [`prd-012b-client-swr-hook`](./prd-012b-client-swr-hook.md) — the client layer this composes with.
- [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) — the proxy contract refined.
- `src/daemon/proxy.ts:105-144` — the handler extended.
- `src/shared/daemon-routing.ts:11-15` — `resolveEndpointOwner`, the owner dimension of the key.
- `src/daemon/dashboard/host.ts:142-196` — the existing `cache-control` posture precedent.
- `tests/daemon/proxy.test.ts` — the suite extended.
