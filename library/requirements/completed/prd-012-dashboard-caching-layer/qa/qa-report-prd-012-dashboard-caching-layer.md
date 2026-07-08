# QA Report: PRD-012 Dashboard Caching Layer (BFF proxy cache + client SWR)

**Plan document:** `library/requirements/in-work/prd-012-dashboard-caching-layer/prd-012-dashboard-caching-layer-index.md` (+ `prd-012a-bff-proxy-read-cache.md`, `prd-012b-client-swr-hook.md`)
**Audit date:** 2026-07-06
**Base branch:** `main`
**Head:** `feature/prd-012-dashboard-caching-layer` (hive submodule, uncommitted working tree)
**Auditor:** quality-worker-bee

## Summary

The PRD-012 implementation is **complete and faithful to the plan**. All 21 sub-PRD acceptance criteria (8 × a-AC, 10 × b-AC) and all 10 module ACs (m-AC) map to concrete code + tests, the `npm run typecheck && npm test && npm run build` gate is green in my own run modulo the 2 pre-existing out-of-scope `funnel-telemetry` failures (confirmed pre-existing via `git stash` isolation — they fail identically on the clean base with zero PRD-012 changes), and the 5 migrated pages' existing suites still pass (34 dashboard files / 222 tests). One criterion is **PARTIAL** (b-AC-7): 5 of the PRD's ~11 migration-target pages moved to `useSwr`; 6 were **deferred per the PRD's own conservatism rule** (wire invalidation already covers their correctness, so deferral is a UX gap, not a correctness gap). The PRD explicitly permits this, so it does not fail the PRD. **Verdict: PASS WITH WARNINGS** — 0 Critical, 2 Warnings (both non-blocking: the deferred-page UX gap and a soft-cap edge case), 2 Suggestions.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ⚠️ | All 8 a-AC PASS; 9/10 b-AC PASS; b-AC-7 PARTIAL (6 pages deferred per the conservatism rule — permitted). m-AC-7/PARTIAL only on the deferred client-side exclusions. |
| Correctness   | ✅ | Cache key, allowlist, TTLs (2s/5s/30s), write-invalidation map, coalescing, eviction, hard-exclusions, and the SWR hook API all match the PRD exactly. Fail-soft preserved on both layers. |
| Alignment     | ✅ | File placement (`src/daemon/proxy-cache.ts`, `src/dashboard/web/use-swr.ts`), naming, and module boundaries match the PRD's architecture. `useFleetTelemetry` and live-tail `usePoll` feeds untouched (non-goal honored). |
| Gaps          | ✅ | No implicit gaps. Wire write-method invalidation is success-gated on every mutator; project-scoping key dimension present on both layers; injectable test seams present. |
| Detrimental   | ⚠️ | No regressions, no security smells (security-worker-bee: 10/10 CLEAN). One perf-adjacent soft-cap edge case (inflight-only state briefly exceeds 256) documented as a Suggestion. |

---

## Critical Issues (must fix)

None.

---

## Warnings (should fix)

- [ ] **b-AC-7 partial: 6 read-model pages deferred from the SWR migration**, `src/dashboard/web/pages/{hive-graph,settings,sync,logs,projects,lifecycle-panel}.tsx`

  The PRD-012b page-migration table lists 11 pages whose read models move to `useSwr`. The implementation migrated 5 (`dashboard`, `memories`, `harnesses`, `roi`, `graph`) and **deferred 6** (`hive-graph`, `settings`, `sync`, `logs`, `projects`, `lifecycle-panel`). `health.tsx` is correctly NOT in scope — it is fed entirely by `useFleetTelemetry` (b-AC-8), not wire reads. The deferral is **acceptable per the PRD's conservatism rule**: the wire-layer `invalidateSwr` calls (prd-012b) plus the server-side cache (prd-012a) already guarantee correctness for these pages, so the deferral is a missed UX optimization (no warm-cache instant-render on revisit), not a correctness gap. The PRD explicitly frames migration as "mechanical, individually-testable" and the parent index frames the layer as a "performance optimization, never a correctness dependency." **This does not fail the PRD.** Suggested: open a follow-up PRD-012b-continued to migrate the 6 deferred pages so the warm-navigation UX win is consistent across all read-model pages.

  ```ts
  // hive-graph.tsx (deferred) still uses usePoll for hiveGraphStatus/hiveGraphProjection/hiveGraphProjects:
  // grep confirms usePoll import remains on hive-graph.tsx (the only read-model page still polling).
  ```

- [ ] **Server cache size cap is "soft" when every entry is inflight**, `src/daemon/proxy-cache.ts:79-91`

  `evictNearestToExpire()` only considers `kind: "fresh"` entries (those with an `expiresAt`). If a pathological workload put the cache at capacity with only `inflight` entries (all coalescing probes, none yet resolved), the guard `if (minKey !== undefined) map.delete(minKey)` finds nothing to delete and the insert briefly exceeds `maxEntries` by one. The code comment (proxy-cache.ts:88-90) acknowledges this as a deliberate choice ("allow this one insert to briefly exceed the cap rather than drop a live coalescing probe"). This is acceptable: inflight entries resolve quickly into fresh entries (which are then evictable), the dashboard cannot realistically produce 256 concurrent distinct inflight reads, and TTLs are short (2/5/30s). **Non-blocking** — recorded because a strict "256 hard cap" reading of a-AC-6 is not literally met in this edge case. Suggested: if a strict cap is ever wanted, evict the oldest inflight by insertion order as a fallback.

  ```ts
  function evictNearestToExpire(): void {
    // ...
    // If every entry is inflight (no fresh expiresAt to compare), there is no TTL basis to evict
    // on; allow this one insert to briefly exceed the cap rather than drop a live coalescing probe.
    if (minKey !== undefined) map.delete(minKey);
  }
  ```

---

## Suggestions (consider improving)

- [ ] **`evictNearestToExpire` scans the full map on every overflow insert**, `src/daemon/proxy-cache.ts:79-91`

  The eviction policy is O(n) over the map on each new-key insert at capacity. For the default cap of 256 on a single-operator dashboard this is negligible (256 iterations, rarely hit), and the PRD explicitly chose "simplest correct policy … no LRU bookkeeping." No change needed for v1. If the cap ever grows or this becomes a hot insert path, a min-heap keyed by `expiresAt` would make eviction O(log n). Not actionable now — recording as a future pointer.

- [ ] **`setNectarBrooding` indentation drifted one tab in the diff**, `src/dashboard/web/wire.ts:2731-2748`

  The PRD-012b edit re-indented the `setNectarBrooding` method body one tab deeper than its siblings inside the returned client object (the surrounding methods are at one-tab-inside; `setNectarBrooding`'s body is now at two-tabs-inside). This is cosmetic — `tsc`/esbuild ignore it and behavior is unchanged — but it stands out in `git diff` as an accidental reformat. Suggested: de-indent `setNectarBrooding` to match its sibling methods.

---

## Plan Item Traceability

Module ACs (m-AC-*) and sub-PRD ACs (a-AC-*, b-AC-*), each with the file:line that satisfies it and the test that proves it. Status legend: ✅ Pass · ⚠️ Partial · ❌ Fail · 🟦 N/A. Non-Goals (NG-*) confirm scope was audited.

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| m-AC-1 | A repeated GET to a cached read endpoint within TTL crosses loopback at most once | ✅ | `src/daemon/proxy.ts:186-221` (cacheable GET → lookup/fill/HIT), `proxy-cache.ts:145-172` (`CACHEABLE_PATHS`) | `proxy.test.ts:145` cache-hit: `fetchImpl` called once, 2nd is HIT, bodies byte-identical |
| m-AC-2 | A write invalidates affected proxy cache entries synchronously before the response | ✅ | `src/daemon/proxy.ts:177-181` (invalidate loop, `response.ok` + non-GET + before `return`) | `proxy.test.ts:191` write-invalidates: POST `/api/memories` busts list+kpis |
| m-AC-3 | Two concurrent identical GETs coalesce into one loopback fetch (both layers) | ✅ | server `src/daemon/proxy.ts:208-213` + `proxy-cache.ts:108-113`; client `use-swr.ts:33-49` | `proxy.test.ts:268` coalescing (Promise.all → 1 fetch); `use-swr.test.tsx:63` dedupe-concurrent |
| m-AC-4 | Two project headers never collide in the cache | ✅ | `src/daemon/proxy.ts:158,186` (`projectHeader` read + in key); `proxy-cache.ts:353-361` | `proxy.test.ts:236` project-scoping-isolation: A vs B → 2 fetches, swap-back HIT |
| m-AC-5 | Memories→Dashboard→Memories renders instantly from SWR cache on revisit | ✅ | `use-swr.ts:130-160` (snapshot reads cache on mount), `wire.ts` swrKey re-export | `use-swr.test.tsx:46` instant-from-cache + `:87` keepPreviousData-on-remount |
| m-AC-6 | Fail-soft posture unchanged — no new throw to React, no new 5xx | ✅ | server `proxy.ts:222-227` (catch → 502 MISS, not cached); client `use-swr.ts:184-193` (catch → `error:"failed"`, keeps data) | `proxy.test.ts:334` loopback-guard-no-cache; `use-swr.test.tsx:162` fail-soft-on-error |
| m-AC-7 | SSE streams, `/recall` POST, `/setup/*` remain uncached on both layers | ⚠️ | server hard-exclude `proxy-cache.ts:369-378`; client: SWR simply is not used on SSE (`logs/stream`) and `/recall` (POST, never a GET read) — verified no `useSwr` wraps these | `proxy-cache.test.ts:141` isHardExcluded; `proxy.test.ts:292` bypass. **PARTIAL only because** the server side is fully enforced while the client relies on convention (no SSE/SWIM surface is migrated). Correctness holds. |
| m-AC-8 | Cached response never from non-loopback; redirect-pin reject never cached | ✅ | `proxy.ts:160-164` (loopback gate before any lookup); `proxy.ts:256` (`redirect:"error"`), `proxy.ts:222-227` (reject → delete inflight, not cached) | `proxy.test.ts:121` non-loopback guard; `proxy.test.ts:357` redirect-pin |
| m-AC-9 | `proxy.test.ts` passes unchanged + new tests for cache behaviors | ✅ | `tests/daemon/proxy.test.ts` (5 pre-existing + 10 new PRD-012a cases) | All 15 pass; existing assertions on `fetchImpl` counts honored |
| m-AC-10 | Page tests pass with SWR-migrated pages + new SWR tests | ✅ | `tests/dashboard/*` (34 files/222 tests) + `tests/dashboard/use-swr.test.tsx` (8) | All dashboard suites green; migrated pages' tests unbroken |
| a-AC-1 | Cache key = `method:owner:pathname:search:projectHeader` | ✅ | `proxy-cache.ts:353-361`; consumed `proxy.ts:186` | `proxy-cache.test.ts:163` computeCacheKey encodes all 5 segments verbatim; header name matches `PROJECT_HEADER` (`wire.ts:181`) |
| a-AC-2 | Path allowlist (GET-readonly, TTLs 2s/5s/30s), exact-match | ✅ | `proxy-cache.ts:145-172` (`CACHEABLE_PATHS` Map, 22 entries); `proxy.ts:167` (`CACHEABLE_PATHS.has(endpointPath)`, pathname only) | `proxy-cache.test.ts:122` exact-match incl. `/api/logs` cached, `/api/logs/stream`+`/history` not |
| a-AC-3 | Write-invalidation map (broad-prefix by owner); `actionsRestart` invalidates nothing | ✅ | `proxy-cache.ts:195-345` (16 explicit rules + conservative default); restart rule `:276-278` → `[]` | `proxy-cache.test.ts:179` resolveWriteInvalidations (memories/modify/forget/sync/restart→[]/org-switch ALL); `proxy.test.ts:225` restart does not invalidate |
| a-AC-4 | Coalescing via inflight `Promise<Response>` | ✅ | `proxy.ts:208-213` (setInflight), `proxy-cache.ts:43,108-113` | `proxy.test.ts:268` coalescing: 2 concurrent GETs → 1 fetch, 2nd header HIT |
| a-AC-5 | `X-Hive-Cache: HIT\|MISS\|BYPASS` on every proxied response | ✅ | `proxy.ts:114-124,191,198,201,221,226,173,182` (`withCacheHeader` on every return path) | `proxy.test.ts:319` x-hive-cache header on every response (all three) |
| a-AC-6 | Size bound (default 256) with nearest-expiresAt eviction | ✅ | `proxy-cache.ts:66,104-113` (`maxEntries`, `evictNearestToExpire`) | `proxy-cache.test.ts:103` eviction (cap 2, nearest-to-expire evicted); `proxy.test.ts:379` proxy honors injected cap |
| a-AC-7 | Injectable `ProxyCache` + `now()` seam for tests | ✅ | `proxy.ts:39-48` (`cache?`, `now?` options); `proxy-cache.ts:31-56,72` | `proxy.test.ts:169` cache-miss-after-ttl advances injected clock; `:379` injects a cap-2 cache |
| a-AC-8 | Hard-exclude POST `/recall`, `/setup/*`, SSE streams, `/api/memories/:id` | ✅ | `proxy-cache.ts:369-378` (`isHardExcluded`); `proxy.ts:167,177` (gate both cacheability and invalidation) | `proxy-cache.test.ts:141` isHardExcluded (all 5 categories); `proxy.test.ts:292` bypass-non-cacheable |
| b-AC-1 | `useSwr(key, fn, opts)` with keepPreviousData/revalidateOnFocus/dedupeMs/refreshInterval | ✅ | `use-swr.ts:103-239` (all 4 options honored: `:145` keepPrev default true, `:146` revalidateOnFocus default true, `:147` dedupeMs default 2000, `:144/210` refreshInterval) | `use-swr.test.tsx:46,87,100,145` |
| b-AC-2 | `invalidateSwr(...prefixes)` + `clearSwrCache()` mutation API | ✅ | `use-swr.ts:67-89` (both exported; prefix-match delete + subscriber-trigger) | `use-swr.test.tsx:127` mutation-invalidation; `:181` clearSwrCache |
| b-AC-3 | WireClient write methods call `invalidateSwr` after successful ack | ✅ | `wire.ts:2403-2990` (17 call sites, all success-gated: `ack !== null`/`parsed.success`/`res.ok`/`ack.bound`) | mirrored server map; security report T7 verified each is on the success path |
| b-AC-4 | Concurrent identical reads dedupe (inflight + cache) | ✅ | `use-swr.ts:33-49` (`fetchSwr` joins inflight promise) | `use-swr.test.tsx:63` dedupe-concurrent: 2 hooks → 1 fetcher call |
| b-AC-5 | Background-tab pause (`isTabHidden`) + immediate revalidate on focus | ✅ | `use-swr.ts:212` (interval skipped when hidden), `:217-220` (visibilitychange → revalidate) | `use-swr.test.tsx:100` revalidateOnFocus: hidden=no tick, focus=refetch |
| b-AC-6 | `undefined` key disables hook (no conditional-hook violation) | ✅ | `use-swr.ts:131,143,163-166` (hook always called; `key===undefined` short-circuits the effect, returns `{data:undefined,loading:false}`) | `use-swr.test.tsx:145` undefined-key-disables; memories.tsx:573 + graph.tsx:449 use it |
| b-AC-7 | Page migration: 11 read-model pages → useSwr | ⚠️ | Migrated 5: `dashboard.tsx:180-195`, `memories.tsx:573-577`, `harnesses.tsx:389-404`, `roi.tsx:684-695`, `graph.tsx:449-456`. **Deferred 6**: hive-graph/settings/sync/logs/projects/lifecycle-panel | PARTIAL — deferral permitted by the PRD's conservatism rule (wire invalidation covers correctness). See Warning #1. |
| b-AC-8 | `useFleetTelemetry` + live-tail `usePoll` feeds stay intact | ✅ | `use-fleet-telemetry.ts` untouched (`git diff --stat` empty); dashboard logs+harnesses polls `dashboard.tsx:228,235`; memories watch poll `memories.tsx:605-621` | `use-fleet-telemetry-hook.test.tsx` (dashboard suite) green; b-AC-5 copy-map intact |
| b-AC-9 | `swrKey` helper exported from `wire.ts` | ✅ | `wire.ts:38` (`export { swrKey } from "./use-swr.js"`) | used by all 5 migrated pages; `copy-map.test.ts` file count 53→54 |
| b-AC-10 | Scope switch calls `clearSwrCache()` | ✅ | `scope-context.tsx:286-292` (`commitScope` → `clearSwrCache()`) + `wire.ts:2978,2994` (switchOrg/switchWorkspace also clear for non-UI callers) | `scope-context.test.tsx` (dashboard suite) green; clearSwrCache unit-tested `use-swr.test.tsx:181` |
| NG-1 | Non-goal: persistent/on-disk caching | ✅ | — | Honored — `createInMemoryProxyCache` holds a `Map` in process memory; no fs/IDB writes |
| NG-2 | Non-goal: distributed/multi-instance cache | ✅ | — | Honored — no Redis/shared-store; module-level cache only |
| NG-3 | Non-goal: new runtime dependency (TanStack Query/SWR) | ✅ | — | Honored — `use-swr.ts` imports only `react` + `isTabHidden`; `package.json` deps unchanged |
| NG-4 | Non-goal: caching POST `/recall`/SSE/`/setup/*` | ✅ | `proxy-cache.ts:369-378` | Honored — hard-excluded; `proxy.test.ts:292` bypass |
| NG-5 | Non-goal: optimistic writes (memories stays re-read-after-write) | ✅ | `memories.tsx:725` (`RE-READ, never optimistic` via `reList()`→`mutateList()`) | Honored — invalidation drives the re-read, no optimistic patch |
| NG-6 | Non-goal: cross-tab SWR synchronization | ✅ | — | Honored — module-level cache is per-tab; no BroadcastChannel |

---

## Regression results (own run)

```
$ npm run typecheck   # tsc --noEmit
(clean — no output)

$ npm run build
Built: 1 dashboard-web bundle → dist/daemon/dashboard/app.js @ 0.6.8

$ npm test
 Test Files  1 failed | 73 passed (74)
      Tests  2 failed | 616 passed (618)
```

The 2 failures are both in `tests/daemon/installer/funnel-telemetry.test.ts` (`ts-AC-13 accepts tenancy_shown…` and `ts-AC-13 tenancy funnel events`) — they assert telemetry-event ordering and fail because an extra `login_completed` event appears between `tenancy_shown`/`onboarding_started` and the next expected event. **They are pre-existing and out of PRD-012 scope.** Confirmed via `git stash push --include-untracked` isolation: with ALL PRD-012 changes removed (clean base), the same 2 funnel-telemetry tests fail identically (`2 failed | 19 passed` in that file alone). PRD-012 touches no installer/telemetry code. Do **not** count these against PRD-012.

**PRD-012-specific suites (all green):**
- `tests/daemon/proxy-cache.test.ts` — 19 tests
- `tests/daemon/proxy.test.ts` — 15 tests (5 pre-existing + 10 new)
- `tests/dashboard/use-swr.test.tsx` — 8 tests
- `tests/dashboard/copy-map.test.ts` — 3 tests (file count updated 53 → 54 for `use-swr.ts`)
- All 34 `tests/dashboard/*` files — 222 tests (migrated pages' suites unbroken; `use-fleet-telemetry-hook.test.tsx` confirms b-AC-8)

No page test that asserted an empty/loading flash was deleted. The migration replaces the flash with `keepPreviousData` (the win); where a prior assertion relied on the flash, the page's data-default (`= EMPTY_KPIS`, `= []`) preserves the same render under the default-value semantics, so the existing page tests pass without assertion rewrites. The new behavior (instant-from-cache) is covered by the dedicated `use-swr.test.tsx` suite.

---

## Files Changed

- `library/ledger/EXECUTION_LEDGER.md` (M), PRD-012 run-log + AC ledger (this audit's flips, recorded separately below)
- `src/daemon/proxy-cache.ts` (A), the `ProxyCache` interface + in-memory impl (TTL, inflight coalescing, nearest-to-expire eviction, owner-scoped prefix invalidation), `CACHEABLE_PATHS` allowlist (22 paths, 2/5/30s), `WRITE_INVALIDATIONS` 16-rule map, `computeCacheKey`, `isHardExcluded`
- `src/daemon/proxy.ts` (M), `createApiProxy` consumes the cache: GET+cacheable → lookup/fill/coalesce/HIT; non-GET 2xx → invalidate before return; every response carries `X-Hive-Cache`; loopback guard + redirect-pin + fail-soft 502 unchanged
- `src/dashboard/web/use-swr.ts` (A), dependency-free `useSwr` hook + module-level `SwrCache` + `invalidateSwr`/`clearSwrCache`/`swrKey` (React + `isTabHidden` only)
- `src/dashboard/web/wire.ts` (M), re-export `swrKey`; 17 write methods call `invalidateSwr`/`clearSwrCache` after successful ack (mirrors server map); no read signatures changed
- `src/dashboard/web/scope-context.tsx` (M), `commitScope` calls `clearSwrCache()` on scope switch
- `src/dashboard/web/pages/dashboard.tsx` (M), kpis/sessions/rules/skills → `useSwr`; `hydrate` bundle + stale-overwrite guard removed; `/api/logs` + `harnesses` strip `usePoll` preserved
- `src/dashboard/web/pages/memories.tsx` (M), `listMemories` → `useSwr` (undefined-key for no-project); re-list-after-write → `mutateList()`; memory-activity watch poll preserved
- `src/dashboard/web/pages/harnesses.tsx` (M), statuses + detail-logs reads → `useSwr` with `refreshInterval`; detail-logs key undefined on overview route
- `src/dashboard/web/pages/roi.tsx` (M), view + trend → `useSwr`; billing ~60s poll becomes `refreshInterval`; trend key encodes `range`
- `src/dashboard/web/pages/graph.tsx` (M), memory-graph → `useSwr` with 8s `refreshInterval`; removed local `isTabHidden`/`alive` guard (hook handles it)
- `tests/daemon/proxy-cache.test.ts` (A), 19 unit tests (TTL, coalescing, prefix invalidation, clear, eviction, allowlist exact-match, hard-exclude, computeKey, resolveWriteInvalidations)
- `tests/daemon/proxy.test.ts` (M), +10 PRD-012a cases (cache-hit, miss-after-ttl, write-invalidates, project-scoping, coalescing, bypass, header, loopback-guard, redirect-pin, size-bound-eviction)
- `tests/dashboard/use-swr.test.tsx` (A), 8 hook tests (instant-from-cache, dedupe-concurrent, keepPreviousData-on-remount, revalidateOnFocus, mutation-invalidation, undefined-key-disables, fail-soft-on-error, clearSwrCache)
- `tests/dashboard/copy-map.test.ts` (M), file count 53 → 54 (`use-swr.ts`)
- `library/requirements/in-work/prd-012-dashboard-caching-layer/` (A, untracked dir), the PRD + this QA report + the (clean) security report
