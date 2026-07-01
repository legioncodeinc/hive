# QA Report: PRD-001 thehive Portal Daemon

**Plan document:** `the-hive/library/requirements/in-work/prd-001-thehive-portal-daemon/prd-001-thehive-portal-daemon-index.md` (+ `prd-001a`, `prd-001b`, `prd-001c`, `prd-001d`)
**Audit date:** 2026-07-01
**Base branch:** `main` (the-hive is untracked greenfield; honeycomb cutover delta reviewed against working tree, uncommitted)
**Head:** `feature/prd-001-thehive-portal-daemon`
**Auditor:** quality-worker-bee

## Ordering check

`security-worker-bee` ran first on this branch (`the-hive/library/requirements/in-work/prd-001-thehive-portal-daemon/qa/security-report.md`, 2026-07-01). It found and remediated one High (SSRF/trust-boundary on the federated `wire` client) and documented two Low follow-ups. The ledger's Close-out A entry confirms "clean at medium+... `quality-worker-bee` may now run." Ordering is correct; this audit proceeds.

## Summary

PRD-001's implementation is substantively complete: every a-AC/b-AC/c-AC/d-AC (26 of 27 sub-PRD criteria) is met with direct code and test evidence, `npm run typecheck && npm test && npm run build` pass clean in `the-hive` (12 files / 41 tests), and the honeycomb cutover delta (Wave 5) verifies clean too (`npm run typecheck` + 4 relevant suites, 68/68 tests). Two Warnings and one ledger-accuracy note stand out: the dashboard shell's daemon-liveness gate (`app.tsx`) is scoped to honeycomb's `/health` only rather than per-daemon, which will incorrectly blank a future hivenectar-owned page even though `wire`'s per-endpoint fail-soft mechanism (c-AC-1 through c-AC-4) is itself correct; and m-AC-5 (independent release train) has no CI/CD automation, though the repo/package separation already satisfies the architectural decoupling the criterion describes. No Critical findings. Recommend shipping with the two Warnings tracked as fast-follow items.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | 26/27 sub-PRD ACs (a-1..7, b-1..5, c-1..5, d-1..8) pass with evidence; m-AC-5 (module-level, no sub-AC) is the one open item, tracked as a Warning, not a Critical gap. |
| Correctness   | ⚠️ | Behavior matches the plan for nearly every AC; one divergence: the Shell's connectivity gate checks honeycomb's `/health` only, not a per-daemon aggregate (affects c-AC-3's UI-layer realization). |
| Alignment     | ✅ | File dispositions match `prd-001b`'s copy-map exactly (28 files migrated, counts reconcile); honeycomb's non-web ViewBlock/TUI layer and `/api/*`/`/health` untouched; no out-of-scope files in the diff. |
| Gaps          | ⚠️ | m-AC-5 release-train automation is a genuine implied-but-missing gap (Warning); one stale honeycomb doc (`CONVENTIONS.md`) still describes a removed seam. |
| Detrimental   | ✅ | No regressions found; honeycomb's own typecheck + the 4 cutover-relevant suites (68 tests) pass after the delta; no dead code, no leftover debug artifacts, no N+1/perf anti-patterns identified. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Dashboard shell's daemon-liveness gate is honeycomb-scoped, not per-daemon (c-AC-3 UI-layer gap)** — `the-hive/src/dashboard/web/app.tsx:94-135, 226-242`, `the-hive/src/dashboard/web/wire.ts:1666, 2171-2186`

  `prd-001c` c-AC-3 requires "one daemon down degrades its panels only... the rest of the dashboard renders." The per-endpoint `wire` methods (`getJson`, `EMPTY_*` fallbacks) correctly implement this at the data layer — verified by `tests/wire/fail-soft.test.ts`. But `Shell`'s single `daemonUp` state, set from one `wire.health()` call, gates the **entire** `<Outlet>` (every routed page, regardless of owning daemon): when `daemonUp` is `false` the whole content region swaps for `<ConnectivityBanner>` instead of routing to the active page. `wire.health()` fetches `ENDPOINTS.health = "/health"`, which `resolveEndpointOwner` routes to `"honeycomb"` (the default owner for any non-`/api/source-graph/*` path, `the-hive/src/shared/daemon-routing.ts:11-15`). This is honeycomb's own single-daemon dashboard behavior, copied into `app.tsx` (a file `prd-001b` explicitly marks "copy with modification" for the multi-daemon posture) without adapting the connectivity gate itself. Today this is not user-visible because no hivenectar-owned page exists yet in the migrated surface (a `prd-001b` non-goal), so there is nothing yet to be incorrectly blanked — but the mechanism as built will hide a future hivenectar page (e.g. Source Graph) whenever honeycomb alone is down, contradicting c-AC-3's per-daemon isolation the moment a second-daemon page ships.

  Suggested: derive `daemonUp` per-owner (or drop the whole-page gate in favor of per-panel unreachable states the individual pages already render via `EMPTY_*`/`degraded` fields), so a page routed to a healthy daemon keeps rendering even while another daemon is down.

  ```tsx
  const [daemonUp, setDaemonUp] = React.useState(true);
  usePoll(async () => {
    const { up, reasons } = await wire.health(); // always checks the "honeycomb" owner
    setDaemonUp(up);
    ...
  }, HEALTH_POLL_MS);
  ...
  {daemonUp ? <Outlet .../> : <ConnectivityBanner .../>}  // blanks ALL pages, not just honeycomb-owned ones
  ```

- [ ] **m-AC-5 (independent release train) has no CI/CD automation** — no `the-hive/.github/workflows/*` exists; ledger `the-hive/library/ledger/EXECUTION_LEDGER.md:19` lists it `OPEN`

  The module AC requires "thehive ships on its own release train: a dashboard change requires no hivedoctor, honeycomb, or hivenectar release, and hivedoctor's updates do not force a thehive redeploy." The *architectural* half of this is satisfied: `the-hive` is a fully separate npm package/repo (`the-hive/package.json:1-2`) with its own `build`/`typecheck`/`test` scripts and zero runtime import of `honeycomb`/`hivedoctor` source (confirmed: no `deeplake` client, no cross-repo `import` found in `the-hive/src`). What is missing is the automation that operationalizes an independent release (a CI workflow, a publish/deploy pipeline) — there is none in `the-hive` yet. This is correctly tracked `OPEN` in the ledger rather than `DONE`, so no ledger drift here; flagging so it is not lost as a fast-follow.

  Suggested: add a `the-hive/.github/workflows/ci.yml` (typecheck + test + build) and a release workflow, mirroring `honeycomb`'s CI shape, before declaring m-AC-5 complete.

## Suggestions (consider improving)

- [ ] **Stale honeycomb doc still describes the removed `mountDashboardHost` seam** — `honeycomb/src/daemon/runtime/dashboard/CONVENTIONS.md:48, 61`

  The doc reads `mountDashboardHost(daemon, { storage, scope? })` attaches `GET /dashboard` onto the root group` and "021a/021f fires `mountDashboardHost(daemon, { storage })` once," but `mountDashboardHost` and `host.ts`/`web-assets.ts` were deleted from honeycomb in Wave 5 (confirmed: `git status` shows both `D`, and `assemble.ts` no longer calls it). Not required by any `prd-001b` AC, but a future reader of this CONVENTIONS doc will be misled into thinking the seam still exists.

  Suggested: strike the `mountDashboardHost` reference (or replace with a pointer to thehive's `ADR-0001`) the next time this file is touched.

- [ ] **`tests/wire/fail-soft.test.ts` has no two-daemon isolation scenario** — `the-hive/tests/wire/fail-soft.test.ts:47-64`

  c-AC-3's existing test proves fail-soft isolation *within* one daemon (one honeycomb endpoint fails, a sibling honeycomb endpoint still succeeds), but not the literal "honeycomb down, hivenectar still renders" scenario the AC describes. Not currently testable end-to-end because no hivenectar-owned dashboard endpoint exists yet in `ENDPOINTS` — this is a coverage gap to close once a hivenectar page ships, not a defect today.

  Suggested: add a test once a hivenectar-routed endpoint exists in `ENDPOINTS`, asserting a honeycomb fetch failure does not affect a concurrent hivenectar fetch.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| m-AC-1 | thehive runs as its own OS process with `/health`, PID/lock, port 3853, independent of honeycomb/hivenectar | ✅ | `the-hive/src/daemon/server.ts:55-80`, `the-hive/src/lock.ts:50-96`, `the-hive/src/shared/constants.ts:5-11` | |
| m-AC-2 | Dashboard shell renders on socket bind before workload daemon health confirmed | ✅ | `the-hive/src/daemon/dashboard/host.ts:115-133`; `tests/daemon/server.test.ts:41-50` (a-AC-3) | GET `/` is unconditional, never awaits honeycomb/hivenectar `/health`. |
| m-AC-3 | Same route registry + pages as retired honeycomb dashboard via injected `wire` | ✅ | `the-hive/src/dashboard/web/registry.tsx:196-218`; `tests/dashboard/registry.test.ts:10-46` | Ledger lists this `IN PROGRESS`; evidence (b-AC-1/b-AC-2, fully tested) shows it is complete — see ledger-accuracy note below. |
| m-AC-4 | No Deep Lake client; fail-soft per-daemon aggregation | ⚠️ | `the-hive/package.json:23-29` (no deeplake dep); `the-hive/src/dashboard/web/app.tsx:94-135` | Data-layer fail-soft (c-AC-1..4) is correct; UI-shell daemonUp gate is honeycomb-scoped, not per-daemon (Warning above). |
| m-AC-5 | Independent release train (thehive-only deploy surface) | ⚠️ | `the-hive/package.json:1-22` (structural separation only) | No CI/CD workflow exists yet (Warning above); correctly `OPEN` in ledger. |
| m-AC-6 | honeycomb `/` + `web/` retired only after thehive serves | ✅ | `honeycomb/src/daemon/runtime/assemble.ts:913-918` (comment + `if (mode === "local")` setup-only block); `git status` shows 28 `D` under `honeycomb/src/dashboard/web/` | |
| m-AC-7 | hivedoctor supervises via idempotent registry entry, no hivedoctor restart | ✅ | `the-hive/src/install/registry.ts:121-152`; `tests/install/registry.test.ts:22-97` (d-AC-6/7/8) | |
| a-AC-1 | Hono app, dashboard mount, bind port 3853 | ✅ | `the-hive/src/daemon/server.ts:55-80`; `tests/daemon/server.test.ts:76-93` | |
| a-AC-2 | `GET /health` returns `status` + `uptimeMs` + `version` | ✅ | `the-hive/src/daemon/server.ts:64-70`; `tests/daemon/server.test.ts:25-39` | |
| a-AC-3 | Dashboard shell served immediately without waiting on daemon `/health` | ✅ | `the-hive/src/daemon/dashboard/host.ts:123-126`; `tests/daemon/server.test.ts:41-50` | |
| a-AC-4 | Writes `~/.honeycomb/thehive.pid` and `thehive.lock` | ✅ | `the-hive/src/lock.ts:50-90`; `tests/lock.test.ts:25-32` | |
| a-AC-5 | Second start exits rather than double-bind | ✅ | `the-hive/src/lock.ts:63-66`; `tests/lock.test.ts:34-41` | |
| a-AC-6 | Stale lock reclaimed when PID dead | ✅ | `the-hive/src/lock.ts:63-70`; `tests/lock.test.ts:43-54` | |
| a-AC-7 | App construction pure; only `startThehive` calls `listen()` | ✅ | `the-hive/src/daemon/server.ts:55-97`; `tests/daemon/server.test.ts:76-93, 95-107` | |
| b-AC-1 | Same `ROUTES` entries as honeycomb registry | ✅ | `the-hive/src/dashboard/web/registry.tsx:196-218`; `tests/dashboard/registry.test.ts:10-38` | 9 labels + 9 hash routes match the PRD list exactly. |
| b-AC-2 | Pages hydrate through injected `wire` unchanged | ✅ | `the-hive/src/dashboard/web/registry.tsx` (component refs); `tests/dashboard/registry.test.ts:40-46` | |
| b-AC-3 | honeycomb removes `/` mount only after thehive serves | ✅ | `honeycomb/src/daemon/runtime/assemble.ts:913-918`; `the-hive/tests/daemon/server.test.ts:41-50` (thehive shell live independent of cutover) | |
| b-AC-4 | honeycomb keeps `/health` and `/api/*` after retirement | ✅ | `honeycomb/src/daemon/runtime/server.ts:71-108` (unchanged, not in modified-file set); `tests/dashboard/logs.test.ts` (8/8 pass) | |
| b-AC-5 | Copy-map complete for all 36 dashboard files | ✅ | `the-hive/tests/dashboard/copy-map.test.ts:28-75` (28-file count + shell/infra/pages/partial-contracts assertions) | 24 verbatim + 4 modified = 28 migrated; 7 stay + `contracts.ts` split reconciles to 36. |
| c-AC-1 | `wire` fetches each endpoint from owning daemon base | ✅ | `the-hive/src/shared/daemon-routing.ts:11-15, 47-50`; `tests/wire/federation.test.ts:5-12`, `tests/wire/fail-soft.test.ts:23-45` | |
| c-AC-2 | hivenectar `/api/source-graph/*` routed to hivenectar | ✅ | `the-hive/src/shared/daemon-routing.ts:9-15`; `tests/wire/federation.test.ts:14-20` | |
| c-AC-3 | One daemon down degrades its panels only | ⚠️ | `the-hive/src/dashboard/web/wire.ts` (per-endpoint `getJson`, data layer ✅); `the-hive/src/dashboard/web/app.tsx:94-135` (UI shell ⚠️, see Warning) | Data-layer isolation proven (`tests/wire/fail-soft.test.ts:47-64`); UI-shell gate is honeycomb-only, not per-daemon. |
| c-AC-4 | Malformed responses degrade via zod, no React throw | ✅ | `the-hive/src/dashboard/web/wire.ts` (zod schemas + `EMPTY_*` fallbacks); `tests/wire/fail-soft.test.ts:66-77` | |
| c-AC-5 | No Deep Lake client in thehive | ✅ | `the-hive/package.json:23-37` (no deeplake dependency); no `deeplake`/`@activeloop` import found under `the-hive/src` | |
| d-AC-1 | `install-service` writes platform unit (launchd/systemd/schtasks) | ✅ | `the-hive/src/service/index.ts:148-183`; `tests/service/service-module.test.ts:5-47` | |
| d-AC-2 | Service starts thehive on boot/login | ✅ | `the-hive/src/service/templates.ts:20-51, 72-115` (`RunAtLoad`, `LogonTrigger`); `tests/service/templates.test.ts:14-44` | |
| d-AC-3 | Service restarts thehive on crash | ✅ | `the-hive/src/service/templates.ts:39-42, 63-65, 102-105` (`KeepAlive`, `Restart=always`, `RestartOnFailure`); `tests/service/templates.test.ts:14-44` | |
| d-AC-4 | `uninstall-service` removes only thehive unit | ✅ | `the-hive/src/service/index.ts:186-215`; `tests/service/service-module.test.ts:49-74` | |
| d-AC-5 | thehive unit execs thehive entrypoint, not hivedoctor | ✅ | `the-hive/src/cli.ts:65, 72-73` (`fileURLToPath(import.meta.url)` as `execPath`); `the-hive/src/service/templates.ts:20-70` | |
| d-AC-6 | Registry contains thehive entry with name, healthUrl, pidPath | ✅ | `the-hive/src/install/registry.ts:95-105`; `tests/install/registry.test.ts:22-33` | |
| d-AC-7 | Re-install updates entry in place (idempotent) | ✅ | `the-hive/src/install/registry.ts:128-133`; `tests/install/registry.test.ts:35-71` | |
| d-AC-8 | Atomic JSON write; no hivedoctor restart or code change | ✅ | `the-hive/src/install/registry.ts:136-146`; `tests/install/registry.test.ts:73-97` | Confirmed no hivedoctor source touched anywhere in this PRD's diff. |
| NG (index) | hivedoctor registry impl out of scope | ✅ Honored | | thehive only reads/writes as consumer (`the-hive/src/daemon/registry.ts`, `the-hive/src/install/registry.ts`). |
| NG (index) | New page content (e.g. hivenectar Source Graph) out of scope | ✅ Honored | | No new page added to `ROUTES`; matches PRD-001b's stated non-goal. |
| NG (index) | honeycomb ViewBlock/TUI layer out of scope | ✅ Honored | | `honeycomb/src/dashboard/{dashboard,views,html,index}.ts` untouched (not in `git status`); only `launch.ts`/`install.ts` URL constants changed. |
| NG (index) | Runtime daemon registration out of scope | ✅ Honored | | Registration only fires from `install-service`/`register` CLI commands (`the-hive/src/cli.ts:31-44, 53-61`); no runtime HTTP registration route. |
| NG (001b) | `wire.ts` internals out of scope (belongs to 001c) | ✅ Honored | | Federation logic lives in `prd-001c`'s `daemon-routing.ts`/`registry.ts`, not re-litigated in 001b. |
| NG (001c) | Dashboard components consuming `wire` unchanged | ✅ Honored | | Pages under `the-hive/src/dashboard/web/pages/*` take `PageProps` only, no daemon-aware code added. |
| NG (001c) | hivedoctor registry schema not owned by thehive | ✅ Honored | | `the-hive/src/daemon/registry.ts` treats the schema as a given (zod-validated read only, no schema authorship). |
| NG (001d) | hivedoctor registry schema/read-on-boot not owned; no runtime registration API; thehive does not supervise others | ✅ Honored | | `the-hive/src/install/registry.ts` is install-time-only file edit; no supervisor code in thehive. |

## Files Changed

**`the-hive` (greenfield, untracked — evidenced by file presence, not diff):**

- `src/cli.ts` — CLI entrypoint (`start`, `install-service`, `uninstall-service`, `register`).
- `src/daemon/dashboard/host.ts` — dashboard shell + static-asset routes (a-AC-3, b-AC-1/2).
- `src/daemon/dashboard/web-assets.ts` — CSS/logo/bundle/font asset reader (font allow-list; reviewed clean by security).
- `src/daemon/registry.ts` — hivedoctor registry reader → daemon bases (c-AC-1, c-AC-2; SSRF-hardened by security fix).
- `src/daemon/server.ts` — `createThehive`/`startThehive`, `/health`, `/api/daemon-bases` (a-AC-1/2/7, m-AC-1).
- `src/dashboard/contracts.ts` — partial copy of honeycomb's ROI view-model types (b-AC-5).
- `src/dashboard/web/*.tsx`, `*.ts` (24 files) — copied verbatim from honeycomb (b-AC-1, b-AC-2, b-AC-5).
- `src/dashboard/web/app.tsx`, `main.tsx`, `setup-gate.tsx`, `wire.ts` — copied with modification for the federated posture (b-AC-1/2; `wire.ts` also c-AC-1..5; `app.tsx` carries the Warning above).
- `src/errors.ts` — `DaemonAlreadyRunningError`.
- `src/install/registry.ts` — thehive's hivedoctor registry upsert (d-AC-6/7/8).
- `src/lock.ts` — single-instance PID/lock guard (a-AC-4/5/6).
- `src/service/{commands,index,platform,templates}.ts` — service unit install/uninstall (d-AC-1..5).
- `src/shared/{constants,daemon-routing,lifecycle-flags,memory-types}.ts` — shared constants + endpoint routing table (m-AC-1, c-AC-1/2; `daemon-routing.ts` carries the SSRF fix).
- `tests/**` (13 files) — Vitest suites named by the AC they prove; 41 tests, all passing.
- `esbuild.config.mjs`, `package.json`, `tsconfig.json` — build config for the copied React bundle.

**`honeycomb` (cutover delta, uncommitted working-tree diff against `main`):**

- `esbuild.config.mjs` (M) — removed the dashboard-web bundle target (b-AC-3/4, m-AC-6).
- `src/commands/install.ts` (M) — `openDashboard`/`localDashboardUrl`/`loopbackDashboardUrl` now point at thehive's `:3853` (m-AC-6); verified by `tests/commands/install.test.ts` (16/16 pass).
- `src/dashboard/launch.ts` (M) — `portalBaseUrl()` replaces the daemon-local dashboard URL resolver (m-AC-6).
- `src/daemon/runtime/assemble.ts` (M) — removed `mountDashboardHost` call; local-mode root group now mounts only `/setup/{login,state,migrate-from-hivemind}` (b-AC-3/4, m-AC-6); verified by `tests/daemon/runtime/assemble.test.ts` (39/39 pass) and `tests/daemon/runtime/assembled-net.test.ts` (5/5 pass).
- `src/daemon/runtime/dashboard/host.ts` (D) — deleted (retired to thehive).
- `src/daemon/runtime/dashboard/web-assets.ts` (D) — deleted (retired to thehive).
- `src/dashboard/web/**` (D, 28 files) — deleted; migrated verbatim/modified into `the-hive` per the copy-map.
- `src/daemon/runtime/dashboard/CONVENTIONS.md` — **not updated**, still references the deleted `mountDashboardHost` seam (Suggestion above).

## Verification commands run

- `the-hive`: `npm run typecheck && npm test && npm run build` — **all pass** (12 test files / 41 tests; build emits `dist/daemon/dashboard/app.js`).
- `honeycomb`: `npm run typecheck` — **pass** (no errors).
- `honeycomb`: `npx vitest run tests/daemon/runtime/assemble.test.ts tests/daemon/runtime/assembled-net.test.ts tests/commands/install.test.ts tests/dashboard/logs.test.ts` — **all pass** (4 files / 68 tests).

## Verdict

**Overall: PASS with Warnings.** 0 Critical, 2 Warnings, 2 Suggestions. No medium+ FAIL. **Shippable** with the two Warnings tracked as fast-follow items (the daemon-liveness UI gate should be fixed before a hivenectar-owned dashboard page ships; the release-train CI automation should land before m-AC-5 is declared complete).
