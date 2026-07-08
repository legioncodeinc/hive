# QA Report: PRD-012b-continued — Deferred page migrations to `useSwr`

**Plan document:** `library/requirements/in-work/prd-012-dashboard-caching-layer/prd-012b-client-swr-hook.md` (Page-migration table, §"Page migration", lines 173-186) + parent index `prd-012-dashboard-caching-layer-index.md` (b-AC-7, b-AC-8, m-AC-6)
**Audit date:** 2026-07-06
**Base branch:** `main`
**Head:** `feature/prd-012b-continued-page-migrations` (hive submodule; uncommitted working tree on top of PR #18's `75ad4c9`)
**Auditor:** quality-worker-bee

## Summary

The PRD-012b-continued continuation is **complete and faithful to the plan**. All 6 pages that PR #18 deferred (b-AC-7 PARTIAL) — `hive-graph`, `settings`, `sync`, `logs`, `projects`, `lifecycle-panel` — now read their read models through `useSwr`; every SSE / live-tail / per-query-POST feed that b-AC-8 protects is intact; fail-soft is preserved on every migrated read (m-AC-6); and `health.tsx` is the only correctly-excluded page (it is `useFleetTelemetry`-fed, not wire reads). The gate is green in my own run (`npm run typecheck` clean, `npm run build` succeeds, `npm test` = 616 passed / 2 failed) modulo the same 2 pre-existing, out-of-scope `funnel-telemetry` failures documented in the PR #18 QA report (confirmed untouched by both PR #18 and this continuation). **b-AC-7 can flip from PARTIAL to VERIFIED.** **Verdict: PASS** — 0 Critical, 0 Warnings, 3 Suggestions (none ship-blocking). Ordering is correct: the security addendum ran first and is CLEAN (5/5 threats, 0 remediations).

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All 6 deferred pages migrated to `useSwr`; every read-model page in the PRD table is now covered. No read-model page left polling. |
| Correctness   | ✅ | Each migrated read uses the correct SWR key (project-scoped via `swrKey` where the read is scoped, plain where global; the `?unbound=1` import-list variant is a distinct key). Fail-soft `= EMPTY_*` / `[]` defaults on every read. |
| Alignment     | ✅ | File placement, naming, and module boundaries match the PRD. One PRD-table-vs-code note: `scopeOrgs`/`scopeWorkspaces` are attributed to `projects.tsx` in the table but actually belong to the scope switcher (`scope-context.tsx`); the page only ever read `scopeProjects`. Deferred to `library-worker-bee` (PRD accuracy), not a continuation defect. |
| Gaps          | ✅ | Fail-soft preserved on all 6 pages. SSE tails, `useFleetTelemetry`, and the hive-graph search POST correctly NOT migrated. One test-coverage pointer (logs filter-change keepPreviousData) recorded as a Suggestion. |
| Detrimental   | ✅ | No regressions; no security smells (security addendum CLEAN). 2 cosmetic items recorded as Suggestions (an `act(...)` test warning, an indentation drift in `projects.tsx`). |

---

## Critical Issues (must fix)

None.

---

## Warnings (should fix)

None.

---

## Suggestions (consider improving)

- [ ] **Add a page-level test for the logs `keepPreviousData` filter-change UX win**, `src/dashboard/web/pages/logs.tsx:511-515`

  The PRD's headline UX win for `logs.tsx` is that a filter change no longer flashes empty while the new first page loads — `useSwr(..., { keepPreviousData: true })` keeps the prior page rendered. The hook-level behavior is proven by `tests/dashboard/use-swr.test.tsx:87` (`keepPreviousData-on-remount`), but that test exercises a *remount*, not a *key change on a mounted hook* (which is the filter-flip path). There is no `logs-page.test.tsx` in `tests/dashboard/` (the page has no dedicated render suite), so the no-flash-on-filter-change is covered only transitively. The `historyKey` (`logs.tsx:511`) correctly encodes the full filter set via `buildHistoryQueryString`, and `extraRecords` is reset on key change (`logs.tsx:524-527`), so the behavior is sound — this is purely a "the win is not directly asserted" gap. Suggested: add a small `logs-page.test.tsx` that mounts `LogsPage`, waits for the first page, changes the filter, and asserts the prior records stay visible (loading flag set, data not blanked).

  ```ts
  const historyKey = `${ENDPOINTS.logs}/history${buildHistoryQueryString(toWireFilters(appliedFilters))}`;
  const { data: firstPage = EMPTY_LOGS_HISTORY, loading: historyLoading } = useSwr<LogsHistoryWire>(
  	historyKey,
  	async () => wire.logsHistory(toWireFilters(appliedFilters)),
  	{ keepPreviousData: true },
  );
  ```

- [ ] **`act(...)` warning from `NectarProjectsPanel` in `hive-graph-page.test.tsx`**, `src/dashboard/web/pages/hive-graph.tsx:103-114`

  Running `hive-graph-page.test.tsx` emits `Warning: An update to NectarProjectsPanel inside a test was not wrapped in act(...)`. The migration changed the panel's data source from a `useEffect` poll to two `useSwr` reads (`projectsWire` at `:103`, `tenancy` at `:108`), so the resolve/settled transitions now land as async state updates that the existing test does not await. The suite still **passes** (15/15) — this is a test-hygiene warning, not a failure. Suggested: wrap the assertions that depend on the SWR resolves in `await act(async () => {...})` / `await waitFor(...)` so the warning clears and the test is robust against future SWR-timing changes.

- [ ] **Indentation drift in the migrated `importLoading`/`projects-list` blocks**, `src/dashboard/web/pages/projects.tsx:345-351` and `:624-633`

  The hand-edit that swapped the `useEffect` hydration for `useSwr` re-indented the `importLoading ?` ternary (line 345) and the `projectsLoading ?` ternary (line 624) one tab shallower than their enclosing `<div>`, and the inner `<span>` lines (346-347) have inconsistent internal indentation. This is cosmetic — `tsc`/esbuild ignore it and behavior is unchanged — but it stands out in `git diff` as an accidental reformat (the same class of nit the PR #18 QA flagged for `setNectarBrooding`). Suggested: re-indent both ternaries to align with their parent `<div>`.

  ```tsx
  				</span>
  			{importLoading ? (
  						<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</span>
  					) : importable.length === 0 ? (
  ```

---

## b-AC-7 verdict (the close-out question)

**b-AC-7 flips from PARTIAL → VERIFIED.** All 6 pages PR #18 deferred are migrated. Per-page evidence (file:line → `useSwr` call site + the read it migrated):

| Page | PRD-table read model | Migrated at | SWR key | Status |
|---|---|---|---|---|
| `hive-graph.tsx` | `hiveGraphProjection` | `:495-500` (`wire.hiveGraphFileGraph`) | `swrKey(ENDPOINTS.hiveGraphProjection, project)` (undefined when no project) | ✅ |
| `hive-graph.tsx` | `hiveGraphStatus` | `:501-507` (`wire.hiveGraphStatus`) | `swrKey(ENDPOINTS.hiveGraphStatus, project)` | ✅ |
| `hive-graph.tsx` | `hiveGraphProjects` | `:103-107` (`wire.nectarProjects`) | `ENDPOINTS.hiveGraphProjects` (global; `wire.nectarProjects()` stamps no `?project=`) | ✅ |
| `settings.tsx` | `authStatus` | `:174-179` (`wire.authStatus`) | `ENDPOINTS.authStatus` | ✅ |
| `settings.tsx` | `/api/status` (Embeddings) | `:575-579` (`wire.status`) | `ENDPOINTS.status` | ✅ |
| `settings.tsx` | `/api/status` (Memory) | `:686-690` (`wire.status`) | `ENDPOINTS.status` (shared key → one cache entry) | ✅ |
| `settings.tsx` | `vaultSettings` | `:933-936` (`wire.vaultSettings`) | `ENDPOINTS.vaultSettings` | ✅ |
| `settings.tsx` | `secrets` | `:937-940` (`wire.secretNames`) | `ENDPOINTS.secrets` | ✅ |
| `sync.tsx` | `assets` | `:390-395` (`wire.assetsView`) | `swrKey(ENDPOINTS.assets, project)` (undefined when no project) | ✅ |
| `logs.tsx` | `/api/logs/history` | `:511-515` (`wire.logsHistory`) | `${ENDPOINTS.logs}/history${buildHistoryQueryString(...)}` (full filter set in key; `keepPreviousData: true`) | ✅ |
| `projects.tsx` | `scopeProjects` | `:565-569` (`wire.scopeProjects`) | `ENDPOINTS.scopeProjects` | ✅ |
| `projects.tsx` | `scopeProjects` (unbound variant) | `:307-310` (`wire.scopeProjects({unbound:true})`) | `${ENDPOINTS.scopeProjects}?unbound=1` (distinct key) | ✅ |
| `lifecycle-panel.tsx` | `lifecycleConflicts` | `:213-216` (`readLifecycle(...,"lifecycleConflicts",...)`) | `ENDPOINTS.lifecycleConflicts` | ✅ |
| `lifecycle-panel.tsx` | `lifecycleStaleRefs` | `:217-219` (`readLifecycle(...,"lifecycleStaleRefs",...)`) | `ENDPOINTS.lifecycleStaleRefs` | ✅ |
| `lifecycle-panel.tsx` | `calibration` | `:221-223` (`readLifecycle(...,"calibration",...)`) | `ENDPOINTS.calibration` | ✅ |

**PRD-table note (deferred to `library-worker-bee`, not a finding against this continuation):** the PRD page-migration table row for `projects.tsx` lists `scopeOrgs`, `scopeWorkspaces`, `scopeProjects`. In the codebase `scopeOrgs`/`scopeWorkspaces` are consumed by the **scope switcher** (`scope-context.tsx:321,332,390`), not the `projects.tsx` page — `projects.tsx` on `main` only ever read `scopeProjects` (verified: `git show main:src/dashboard/web/pages/projects.tsx` has 0 `scopeOrgs`/`scopeWorkspaces` references). The continuation faithfully migrated every read `projects.tsx` actually performs; the table over-states the page's surface. This is a PRD-accuracy item for `library-worker-bee`; it does not fail b-AC-7.

## b-AC-8 verification (live tails / SSE / `useFleetTelemetry` intact)

| Protected feed | Location | Mechanism preserved | Status |
|---|---|---|---|
| `sync.tsx` SSE activity feed (`/api/logs/stream`) | `sync.tsx:408-424` | `useEffect` + `wire.logsStream` (EventSource) subscription; the migration replaced only the assets-view POLL, not this block (comment at `:402-407` explicitly states it stays) | ✅ |
| `logs.tsx` `/api/logs/stream` live tail | `logs.tsx:597-615` | `wire.logsStream` subscription, separate from the SWR-driven first-page history; the migration replaced only the `loadHistoryFirstPage` imperative fetch | ✅ |
| `hive-graph.tsx` search (POST `/api/hive-graph/search`) | `hive-graph.tsx:519-525` | `wire.hiveGraphSearch(searchQuery, project)` kept as an imperative POST handler (the `/recall` analogue — per-query compute, not a read model) | ✅ |
| `useFleetTelemetry` | `src/dashboard/web/use-fleet-telemetry.ts` | `git diff main -- use-fleet-telemetry.ts` = 0 lines; untouched | ✅ |
| Live-tail `usePoll` feeds (newest-events-appended) | `sync.tsx` SSE feed, `logs.tsx` SSE tail | Neither is a `usePoll` after this change; both are the SSE subscriptions above, preserved | ✅ |

`health.tsx` — the PRD table's only out-of-scope page — is confirmed `useFleetTelemetry`-fed (`health.tsx:264`), with no `useSwr`/`usePoll`/`useEffect`-for-reads (its only `useEffect` is a `nowMs` clock for heartbeat staleness). Correctly NOT migrated. No other read-model page was missed (`roi-chart.tsx` is a pure presentational component — receives props, does no fetching; `coming-soon.tsx` does no fetching).

## Fail-soft (m-AC-6) preserved

Every migrated read destructure carries its `EMPTY_*` / `[]` / safe-object default, so on a first-load or a fetcher error the page renders its empty/safe state — no throw reaches React. The `useSwr` error path (`use-swr.ts:184-193`) sets `data` to the cached value or `undefined` (never throws), so the destructure default always holds. Per-page defaults: `hive-graph.tsx:103/108/495/501` (`EMPTY_NECTAR_PROJECTS`, `UNREACHABLE_SETUP_TENANCY`, inline `{graph:EMPTY_GRAPH,...}`, `{...EMPTY_HIVE_GRAPH_STATUS,...}`); `settings.tsx:174/575/686/933/937` (`DISCONNECTED_AUTH_STATUS`, undefined→derived `off`/`MEMORY_DEFAULT`, `EMPTY_VAULT_SETTINGS`, `[]`); `sync.tsx:390` (`EMPTY_ASSET_SYNC_VIEW`); `logs.tsx:513` (`EMPTY_LOGS_HISTORY`); `projects.tsx:307/565` (`[]`, `[]`); `lifecycle-panel.tsx:213/217/221` (`[]`, `[]`, `EMPTY_CALIBRATION`). Covered at the hook level by `use-swr.test.tsx:162` (`fail-soft-on-error`).

## Regression results (own run)

```
$ npm run typecheck   # tsc --noEmit
(clean — no output)

$ npm run build
Built: 1 dashboard-web bundle → dist/daemon/dashboard/app.js @ 0.6.8
Stamped: dist/telemetry/emit.js (posthog key empty = disabled)

$ npm test
 Test Files  1 failed | 73 passed (74)
      Tests  2 failed | 616 passed (618)
```

The 2 failures are both in `tests/daemon/installer/funnel-telemetry.test.ts` (`ts-AC-13 accepts tenancy_shown…` and `ts-AC-13 tenancy funnel events`) — they assert telemetry-event ordering and fail because an extra `login_completed` event appears between `tenancy_shown`/`onboarding_started` and the next expected event. **They are pre-existing and out of PRD-012 scope.** Confirmed via `git diff main...HEAD --stat -- tests/daemon/installer/ src/daemon/installer/` and `git status -- src/daemon/installer/ tests/daemon/installer/`: **zero diff** — neither PR #18 nor this continuation touches any installer code or the funnel-telemetry test. The PR #18 QA report already isolated these via `git stash` (they fail identically on clean `main`).

**Migrated-page relevant suites (all green, run in isolation):** `tests/dashboard/hive-graph-page.test.tsx` (15), `embeddings-section.test.tsx`, `memory-formation-section.test.tsx`, `scope-context.test.tsx`, `use-swr.test.tsx` (8) — **45 passed / 0 failed**. No test file was modified by this continuation (`git diff main...HEAD -- tests/` shows only the PR #18 additions: proxy-cache, proxy, copy-map, use-swr; the working tree has no uncommitted test edits), so no test cases were deleted — the existing suites pass unchanged against the migrated pages.

---

## Plan Item Traceability

Scope of this audit: the 6 deferred-page migrations + the b-AC-8/m-AC-6 invariants they touch. The PR #18 QA report (`qa-report-prd-012-dashboard-caching-layer.md`) owns the full m-AC/a-AC/b-AC table; this report scopes to the continuation delta. Status legend: ✅ Pass · ⚠️ Partial · ❌ Fail · 🟦 N/A.

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| b-AC-7a | `hive-graph.tsx`: `hiveGraphStatus`, `hiveGraphProjection`, `hiveGraphProjects` → `useSwr` | ✅ | `src/dashboard/web/pages/hive-graph.tsx:495-507,103-107` | `hiveGraphProjection`+`hiveGraphStatus` project-scoped via `swrKey(...,project)` (undefined when no project); `hiveGraphProjects` = `wire.nectarProjects()` → `ENDPOINTS.hiveGraphProjects` (`wire.ts:2720`) |
| b-AC-7b | `settings.tsx`: `vaultSettings`, `secrets`, `authStatus`, `/api/status` → `useSwr` | ✅ | `src/dashboard/web/pages/settings.tsx:933-940,174-179,575-579,686-690` | Both `/api/status` consumers (Embeddings + Memory sections) share `ENDPOINTS.status` → one cache entry. `authStatus()` fail-soft to `DISCONNECTED` preserved |
| b-AC-7c | `sync.tsx`: `assets` → `useSwr` | ✅ | `src/dashboard/web/pages/sync.tsx:390-395` | `swrKey(ENDPOINTS.assets, project)`; undefined key when no project (renders `NeedsProjectSelection`) |
| b-AC-7d | `logs.tsx`: `/api/logs/history` (paginated table) → `useSwr` | ✅ | `src/dashboard/web/pages/logs.tsx:511-515` | Key encodes full filter set via `buildHistoryQueryString`; `keepPreviousData:true` for the no-flash UX; "load more" stays imperative (`:536-548`) |
| b-AC-7e | `projects.tsx`: `scopeProjects` → `useSwr` | ✅ | `src/dashboard/web/pages/projects.tsx:565-569,307-310` | Main list = `ENDPOINTS.scopeProjects`; import-modal unbound variant = `${ENDPOINTS.scopeProjects}?unbound=1` (distinct key) |
| b-AC-7f | `lifecycle-panel.tsx`: `lifecycleConflicts`, `lifecycleStaleRefs`, `calibration` → `useSwr` | ✅ | `src/dashboard/web/pages/lifecycle-panel.tsx:213-223` | Three plain global keys; resolve poll-to-convergence reads directly (needs return values) then syncs via `mutateConflicts` (`:235-251`) |
| b-AC-7-note | PRD table also lists `scopeOrgs`/`scopeWorkspaces` under `projects.tsx` | 🟦 | `scope-context.tsx:321,332,390` | These belong to the scope **switcher**, not `projects.tsx` (the page never read them — verified on `main`). Continuation migrated everything `projects.tsx` reads. PRD-accuracy item for `library-worker-bee` |
| b-AC-8 | `useFleetTelemetry` + live-tail `usePoll`/SSE feeds stay intact | ✅ | `use-fleet-telemetry.ts` (0-line diff); `sync.tsx:408-424` (SSE); `logs.tsx:597-615` (SSE); `hive-graph.tsx:519-525` (search POST) | All three non-read-model feeds correctly left on their current mechanisms; `useFleetTelemetry` untouched |
| m-AC-6 | Fail-soft posture unchanged — no new throw to React | ✅ | `use-swr.ts:184-193` (error → keep data/undefined, never throw); page destructure defaults listed in "Fail-soft" section above | Every migrated read has an `EMPTY_*`/`[]` default; `use-swr.test.tsx:162` proves the hook does not throw on fetcher error |
| NG-health | Non-goal/out-of-scope: `health.tsx` is `useFleetTelemetry`-fed, NOT migrated | ✅ | `health.tsx:264` | Honored — `useFleetTelemetry`-fed; only `useEffect` is a `nowMs` clock, not a wire read |
| NG-nopage | No other read-model page missed | ✅ | `roi-chart.tsx` (presentational, no fetch), `coming-soon.tsx` (no fetch) | Honored — full page inventory checked; no remaining `useEffect`/`usePoll` read-model page |

---

## Files Changed (continuation delta)

The continuation's delta is the 6 uncommitted page-file modifications below (plus the security addendum to the existing report, which is not an implementation file). `git diff main...HEAD` also shows the PR #18 files because this branch builds on PR #18; those are listed in the PR #18 QA report, not here.

- `src/dashboard/web/pages/hive-graph.tsx` (M) — `NectarProjectsPanel` (nectar projects + tenancy) and the page body (file-graph projection + status) move from `useEffect`+`isTabHidden` polls to `useSwr` with `refreshInterval: HIVE_GRAPH_POLL_MS`; project-scoped reads use `swrKey(...,project)` (undefined-key disables when no project); brooding write revalidates via `mutateProjects()`/`mutateTenancy()`; search POST (`hiveGraphSearch`) stays imperative
- `src/dashboard/web/pages/settings.tsx` (M) — `DeeplakeAuthSection` (authStatus), `EmbeddingsSection` + `MemoryFormationSection` (`/api/status`), and `SettingsPage` (vaultSettings + secretNames) move to `useSwr`; the manual `window.focus` listener and `isTabHidden` warming-poll are replaced by the hook's built-in focus revalidation + a warming `refreshInterval`; settings/secret writes revalidate via `mutateVault()`/`mutateSecretNames()`; embeddings toggle keeps its short-lived optimistic override
- `src/dashboard/web/pages/sync.tsx` (M) — the union assets view-model moves from a `useEffect`+`isTabHidden` poll to `useSwr` (`swrKey(ENDPOINTS.assets, project)`, undefined when no project); the SSE activity feed (`/api/logs/stream`) stays on `useEffect` + `wire.logsStream`; sync actions revalidate via `mutateView()`
- `src/dashboard/web/pages/logs.tsx` (M) — the first-page history read moves from an imperative `loadHistoryFirstPage` to `useSwr` keyed on the full filter set (`buildHistoryQueryString`) with `keepPreviousData:true`; "load more" cursor pagination stays imperative (appends older pages, resets on filter change); the `/api/logs/stream` live tail stays on `wire.logsStream`
- `src/dashboard/web/pages/projects.tsx` (M) — `ProjectsPage` (workspace projects) and `ImportModal` (unbound-projects variant) move from `useEffect` hydration to `useSwr`; the unbound variant uses a distinct `${ENDPOINTS.scopeProjects}?unbound=1` key; bind/import/unbind revalidate via `mutateProjects()` (renamed `reList`)
- `src/dashboard/web/pages/lifecycle-panel.tsx` (M) — the conflict queue, stale-ref list, and calibration introspection move from a single `useEffect` `Promise.all` hydration to three `useSwr` reads; the resolve poll-to-convergence loop reads directly (needs return values for convergence detection) then syncs the cache via `mutateConflicts()`; loading gates switch from `hydrated` to per-read `loading` flags
- `library/requirements/in-work/prd-012-dashboard-caching-layer/qa/security-report.md` (M) — appended the "PRD-012b-continued addendum" (5/5 page-migration threats CLEAN); not an implementation file, listed for completeness
