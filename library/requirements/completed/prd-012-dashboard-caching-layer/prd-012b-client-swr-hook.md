# PRD-012b: Client-side stale-while-revalidate hook

> **Parent:** [`prd-012-dashboard-caching-layer`](./prd-012-dashboard-caching-layer-index.md)
> **Status:** Draft
> **Effort:** L (1-3d)

---

## Overview

Every dashboard page today re-hydrates from scratch on mount. The recipe is `useEffect(() => void hydrate(), [hydrate])` + a separate `usePoll` for live data, with each page holding its own `useState` for the result (`dashboard.tsx:229-251`, `memories.tsx:605-610`, `harnesses.tsx:389-393`, `roi.tsx`'s two `usePoll` loops). When you navigate Memories → Dashboard → Memories, the second Memories mount fires a fresh `GET /api/memories?limit=50`, shows the empty state until it resolves, then populates — even though you saw the same list two seconds ago. Multiple components on one page asking for the same endpoint (e.g., `harnesses` on both the dashboard strip and the harnesses page) each fire their own fetch.

This sub-PRD replaces that ad-hocery for read models with a small, hand-rolled, dependency-free **stale-while-revalidate hook** — `useSwr` — backed by a module-level `SwrCache`. The hook serves the cached value instantly on mount (no empty flash), deduplicates concurrent in-flight requests for the same key, revalidates in the background on focus and on a configurable interval, and exposes a mutation API that invalidates entries by key prefix. The proxy cache from [`prd-012a`](./prd-012a-bff-proxy-read-cache.md) makes the background revalidate cheap; this hook makes the warm-navigation render instant.

The hook is deliberately not a TanStack Query/SWR npm dependency. hive's posture is copy-and-own with minimal deps ([`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md)); `useFleetTelemetry` (`use-fleet-telemetry.ts:283`) and `usePoll` (`page-frame.tsx:133`) already set the precedent of hand-rolling React data hooks. The SWR hook is ~80 lines plus the cache; a future swap to a library is not precluded but is not this PRD.

---

## Goals

- A page revisited within its cache window renders the previous data instantly (no empty flash, no spinner) while a background revalidate refreshes it.
- Two components mounted concurrently that read the same endpoint+scope share one fetch (dedupe) and one cache entry.
- A backgrounded tab does NOT revalidate (inherits `usePoll`'s `isTabHidden` pause); re-focus triggers an immediate revalidate (matches `usePoll`'s `visibilitychange` behavior).
- A mutation (`addMemory`, `forgetMemory`, `modifyMemory`, `compact`, `pollinate`, sync actions, `actionsEmbeddings`/`actionsMemory`/`actionsLogout`, scope switch, project bind/unbind) invalidates the affected SWR entries so the next read reflects the write — without a manual `setX` cascade in every page.
- The hook works inside the existing jsdom test environment (no `EventSource` requirement, controllable timers, injectable fetch via the existing `WireClient` seam).
- The fail-soft posture is unchanged: an SWR error degrades to the same empty/zero render today's code produces. The cache is never a correctness dependency.

## Non-Goals

- **Subsuming `useFleetTelemetry`.** The fleet-telemetry hook (`use-fleet-telemetry.ts`) is SSE-first with a reducer-based ring buffer and a REST fallback; it is not a simple read model. PRD-012b leaves it intact. The SWR hook covers the `usePoll`-style reads only.
- **Subsuming the `usePoll`-based live tails.** `usePoll`-driven feeds that are *inherently* about "what just happened" — the live log lines on the dashboard, the memory-activity log on the memories page — stay on `usePoll`. The SWR hook covers *read models* (KPIs, lists, graphs), not *tails*.
- **Optimistic writes.** Memories stays re-read-after-write (`memories.tsx:732`). PRD-012b makes the re-read cheap via invalidation, not optimistic. Optimism is a separate future PRD.
- **Persistent client cache (localStorage/IndexedDB).** The SWR cache is in-memory, per tab, lost on reload. The proxy cache is what survives a reload (it doesn't — but the round trip it saves is the point).
- **A new dependency.** No TanStack Query, no SWR npm package. Hand-rolled, owned, ~80 lines.
- **Cross-tab synchronization.** Two hive tabs do not share an SWR cache. The proxy cache makes the cross-tab refetch cheap; a `BroadcastChannel`-based cross-tab invalidation is a possible future enhancement, not v1.

---

## The SWR hook API

```ts
// src/dashboard/web/use-swr.ts

export interface SwrOptions<T> {
  /** Revalidate on an interval (ms). 0 = no interval revalidation (mount + focus only). */
  readonly refreshInterval?: number;
  /** Keep rendering the previous data while a revalidate is in flight (default true). */
  readonly keepPreviousData?: boolean;
  /** Revalidate when the tab is foregrounded (default true, matches usePoll). */
  readonly revalidateOnFocus?: boolean;
  /** Dedupe window (ms): a revalidate within this window is skipped (default 2000). */
  readonly dedupeMs?: number;
}

export interface SwrResult<T> {
  readonly data: T | undefined;
  readonly error: "loading" | "failed" | null;
  readonly loading: boolean;          // true only when there is NO cached data yet (first load)
  readonly isValidating: boolean;     // true during any revalidate (background or foreground)
  readonly mutate: (opts?: { readonly revalidate?: boolean }) => void;
}

/**
 * Read a dashboard view-model with stale-while-revalidate semantics.
 *
 * @param key  Stable string key (or undefined to disable the hook — returns loading state).
 *             Convention: `endpoint + ":" + (projectId ?? "")`, e.g. "/api/diagnostics/kpis:proj-7".
 *             The projectId suffix is REQUIRED for project-scoped reads (see parent AC).
 * @param fn   The fetcher. Receives no args; closes over the wire client. Returns T or throws.
 */
export function useSwr<T>(key: string | undefined, fn: () => Promise<T>, options?: SwrOptions<T>): SwrResult<T>;
```

### The mutation API

```ts
// src/dashboard/web/use-swr.ts

/** Invalidate SWR entries whose key starts with any of the prefixes. */
export function invalidateSwr(...prefixes: string[]): void;

/** Invalidate every SWR entry (used on org switch — see parent open question). */
export function clearSwrCache(): void;
```

Pages call `invalidateSwr("/api/memories", "/api/diagnostics/kpis")` after a write, exactly mirroring the proxy's write-invalidation map. The `WireClient`'s write methods (`addMemory`, `forgetMemory`, `modifyMemory`, `compact`, `pollinate`, sync actions) are extended to call `invalidateSwr` internally so individual pages don't repeat the map — but the public function stays available for page-specific invalidation (e.g., a manual refresh button).

---

## Key conventions

- **One key per endpoint+scope.** `"/api/diagnostics/kpis:proj-7"`, `"/api/memories?limit=50:proj-7"`, `"/api/hive-graph/status"`. The key is opaque to the hook; the convention is enforced by a small helper in `wire.ts`:
  ```ts
  export function swrKey(endpoint: string, projectId?: string): string {
    return projectId ? `${endpoint}:${projectId}` : endpoint;
  }
  ```
- **`undefined` key disables the hook** (returns `{ data: undefined, loading: false }`). This is how a page expresses "no project selected → don't fetch" (the `NeedsProjectSelection` state, `memories.tsx:761-762`) without conditional-hook violations.
- **The fetcher closes over the wire client.** `useSwr(key, () => wire.kpis(scope.project), { refreshInterval: 0 })`. The wire client's existing fail-soft (returns `EMPTY_KPIS` on error, never throws) means `error` is rarely `"failed"`; the hook's `error` state is for the rare case the wire method itself throws (a JSON parse the wire didn't catch).

---

## Behavior

```
mount(key):
  if cache[key] exists:
    data = cache[key].value          // instant render, no empty flash
    isValidating = true              // background revalidate fires
    fetcher() → onResolve: cache[key] = {value, ts}; data = value; isValidating = false
               onReject: error = "failed"; isValidating = false (keep data)
  else:
    loading = true; isValidating = true
    fetcher() → onResolve: cache[key] = {value, ts}; data = value; loading = false; isValidating = false
               onReject: error = "failed"; loading = false; isValidating = false

revalidate (interval or focus or manual mutate):
  if Date.now() - cache[key].ts < dedupeMs: skip (dedupe)
  else:
    isValidating = true
    keepPreviousData ? data stays : data = undefined
    fetcher() → update as above

unmount:
  cancel any in-flight fetch owned by this hook (the cache keeps the entry; the next mount reuses it)

invalidateSwr(...prefixes):
  for each cache key starting with any prefix: delete entry
  // any mounted hook whose key was invalidated schedules a revalidate on the next tick
```

### Dedupe of concurrent in-flight

The `SwrCache` holds an `inflight: Map<string, Promise<unknown>>`. When two hooks with the same key mount in the same tick (e.g., dashboard strip + harnesses page both reading `/api/diagnostics/harnesses`), the second hook observes the inflight promise and awaits it rather than firing a second fetch. Both resolve together; both cache the result.

### Background-tab pause

`useSwr` inherits `isTabHidden()` from `page-frame.tsx:129`. While hidden: interval revalidations are skipped, focus listeners stay armed. On `visibilitychange → visible`: an immediate revalidate fires (matches `usePoll`). The cached data stays rendered while hidden (no empty flash on backgrounding).

### `keepPreviousData` default true

This is the single biggest perceived win. On a route-away-and-back, the page renders the previous data instantly while the revalidate runs. Pages that *want* the empty state on every mount (none today, but reserved) can pass `keepPreviousData: false`.

---

## Wire client integration

The `WireClient` (`wire.ts:2295`) is extended so its write methods call `invalidateSwr` after a successful write, centralizing the invalidation map (mirrors the proxy's write-invalidation table in [`prd-012a`](./prd-012a-bff-proxy-read-cache.md)):

```ts
async addMemory(input): Promise<StoreAckWire | null> {
  const ack = await postJson(...);
  if (ack !== null) invalidateSwr("/api/memories", "/api/diagnostics/kpis");
  return ack;
},
async forgetMemory(id, input): Promise<WriteAckWire | null> {
  const ack = await postJson(...);
  if (ack !== null) invalidateSwr("/api/memories", "/api/diagnostics/kpis");
  return ack;
},
// … same shape for modifyMemory, compact, pollinate, sync actions, actionsLogout/Embeddings/Memory,
// graphBuild, hiveGraphBuild, hiveGraphBrooding, scope switches, project bind/unbind.
```

The read methods (`kpis`, `sessions`, `settings`, etc.) are unchanged in signature; pages stop calling them inside `useEffect`/`usePoll` and start calling them inside `useSwr`'s fetcher closure.

---

## Page migration

Each read-driven page is migrated in a small, individually-testable commit. The `usePoll`-driven *tails* (live logs, memory-activity feed) stay on `usePoll`.

| Page | What migrates to `useSwr` | What stays on `usePoll` |
|---|---|---|
| `dashboard.tsx` | `kpis`, `sessions`, `rules`, `skills` (the `hydrate` bundle, `dashboard.tsx:204-226`) | `/api/logs` live feed (`dashboard.tsx:244-247`), `harnesses` strip poll (`dashboard.tsx:251`) |
| `memories.tsx` | `listMemories`, `getMemory` (the detail read) | memory-activity log filter poll (`memories.tsx:610`) |
| `harnesses.tsx` | `harnesses` read, per-harness detail reads | (none — the page's polls become SWR intervals) |
| `roi.tsx` | `roi`, `roiTrend` | (the billing ~60s poll becomes SWR `refreshInterval: 60000`) |
| `graph.tsx` | `graph` read | (none) |
| `hive-graph.tsx` | `hiveGraphStatus`, `hiveGraphProjection`, `hiveGraphProjects` | (the brooding/queue polls become SWR intervals) |
| `health.tsx` | `/api/status`, `/api/diagnostics/harnesses` | (none) |
| `settings.tsx` | `vaultSettings`, `secrets`, `authStatus`, `/api/status` | (none) |
| `sync.tsx` | `assets` read | (the SSE activity feed stays on its existing tail) |
| `logs.tsx` | `/api/logs/history` (the paginated table) | `/api/logs/stream` (the live tail — SSE, never SWR) |
| `projects.tsx` | `scopeOrgs`, `scopeWorkspaces`, `scopeProjects` | (none) |
| `lifecycle-panel.tsx` | `lifecycleConflicts`, `lifecycleStaleRefs`, `calibration` | (none) |

The migration is mechanical: replace `const [kpis, setKpis] = useState(EMPTY_KPIS); useEffect(() => void hydrate(), [hydrate])` with `const { data: kpis = EMPTY_KPIS } = useSwr(swrKey(ENDPOINTS.kpis, scope.project), () => wire.kpis(scope.project))`. The `EMPTY_*` constants already exported from `wire.ts` become the `data = EMPTY_KPIS` default, preserving today's fail-soft empty render.

---

## Test plan

All in `tests/dashboard/`, using `@testing-library/react` + the existing jsdom setup:

- **instant-from-cache:** mount a hook with a pre-seeded cache → renders the cached value synchronously on first paint (no `loading` flash); a background revalidate fires and updates when it resolves.
- **dedupe-concurrent:** mount two hooks with the same key in the same tick → the injected fake `WireClient` method is called exactly once; both hooks resolve with the same data.
- **keepPreviousData-on-remount:** mount, wait for resolve, unmount, remount within TTL → renders the previous data instantly; `loading` is false on the second mount.
- **revalidateOnFocus:** with `revalidateOnFocus: true`, fire `visibilitychange → visible` → a revalidate fires; while hidden, no interval revalidate fires.
- **mutation-invalidation:** call `wire.addMemory(...)` (injected fake returns a non-null ack) → SWR entries with keys starting `/api/memories` and `/api/diagnostics/kpis` are dropped; the next read refetches.
- **undefined-key-disables:** `useSwr(undefined, fn)` returns `{ data: undefined, loading: false }` and never calls `fn` (the no-project-selected guard, no conditional-hook violation).
- **fail-soft-on-error:** the fetcher throws → `error: "failed"`, `data` keeps its previous value (or `undefined` on first load); no throw reaches React.
- **page-migration-smoke:** each migrated page's existing test (`tests/dashboard/*.test.tsx`) passes with the read source swapped to `useSwr`; the empty/loading assertions are updated where the page previously asserted the empty flash (the flash is gone by design — that's the win).
- **background-tab-pause:** in a jsdom-simulated hidden tab, an interval revalidate does not fire; on re-focus it fires immediately.

---

## Files touched

### New files
- `src/dashboard/web/use-swr.ts` — the `useSwr` hook, the module-level `SwrCache`, `invalidateSwr`, `clearSwrCache`, and the `swrKey` helper.
- `tests/dashboard/use-swr.test.tsx` — the hook's unit tests above, independent of any page.

### Modified files
- `src/dashboard/web/wire.ts` — export `swrKey`; the write methods (`addMemory`, `forgetMemory`, `modifyMemory`, `compact`, `pollinate`, sync actions, `actionsLogout`/`actionsEmbeddings`/`actionsMemory`, `graphBuild`, `hiveGraphBuild`, `hiveGraphBrooding`, scope switches, project bind/unbind) call `invalidateSwr` after a successful ack.
- `src/dashboard/web/pages/dashboard.tsx` — `hydrate` bundle (`kpis`/`sessions`/`rules`/`skills`) moves to `useSwr`; the `usePoll` for `/api/logs` and `harnesses` strip stays.
- `src/dashboard/web/pages/memories.tsx` — `listMemories` + `getMemory` move to `useSwr`; the memory-activity log poll stays.
- `src/dashboard/web/pages/harnesses.tsx`, `roi.tsx`, `graph.tsx`, `hive-graph.tsx`, `health.tsx`, `settings.tsx`, `sync.tsx`, `logs.tsx`, `projects.tsx`, `lifecycle-panel.tsx` — the read models listed in the migration table move to `useSwr`.
- `src/dashboard/web/scope-context.tsx` — a scope switch (org/workspace/project change) calls `clearSwrCache()` (every scoped read is potentially different after a switch).
- The corresponding `tests/dashboard/*.test.tsx` files — update loading/empty assertions where the empty flash is gone; add dedupe/keepPreviousData assertions per page.

---

## Open questions

- **Should `useSwr` own the refresh interval, or should pages compose it with `usePoll`?** Default: `useSwr` owns it via `refreshInterval`, replacing the `usePoll` calls for read models. This keeps one mechanism per read (simpler reasoning) and avoids a double-fetch race. The live tails stay on `usePoll` because they are not read models.
- **`mutate` optimistic-update helper.** v1 ships only `mutate({revalidate: true})` (re-fetch) and `invalidateSwr` (drop). A `mutate(updater)` that optimistically patches the cache is reserved for the future optimism PRD. Default: not in v1.
- **Error retry.** v1 does not auto-retry a failed fetcher (the wire client already fail-softs to empty). A retry-with-backoff is a possible future addition if a flappy endpoint proves problematic. Default: not in v1.
- **Cross-tab invalidation.** Two hive tabs each hold their own SWR cache. A write in tab A invalidates A's cache but not B's. The proxy cache makes B's next read cheap and fresh-ish (within its TTL), so this is acceptable for v1. A `BroadcastChannel("hive-swr")`-based invalidation is a clean future enhancement. Default: not in v1.

---

## Related

- [`prd-012-dashboard-caching-layer`](./prd-012-dashboard-caching-layer-index.md) — parent.
- [`prd-012a-bff-proxy-read-cache`](./prd-012a-bff-proxy-read-cache.md) — the server layer this composes with (its `X-Hive-Cache: HIT` makes this hook's background revalidate nearly free).
- [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md) — the copy-and-own posture driving "hand-rolled, no TanStack Query."
- `src/dashboard/web/page-frame.tsx:105-159` — `usePoll` + `isTabHidden`, the recipe replaced for read models and whose behavior is inherited.
- `src/dashboard/web/wire.ts:42-165,174-184,2295-2411` — the endpoint map, project helpers, and wire client the hook wraps.
- `src/dashboard/web/use-fleet-telemetry.ts:283-395` — the SSE-first hook this PRD deliberately does NOT subsume.
- `src/dashboard/web/pages/dashboard.tsx:229-251` — the canonical `useEffect`+`usePoll` hydration migrated.
- `src/dashboard/web/pages/memories.tsx:605-610,732` — the read-after-write pattern the invalidation map makes cheap.
- `tests/dashboard/*` — the page suites kept green and extended.
