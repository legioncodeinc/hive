# QA Report: PRD-002 Portal Readiness Splash

**Plan document:** `library/requirements/in-work/prd-002-portal-readiness-splash/prd-002-portal-readiness-splash-index.md` (+ `prd-002a-fleet-status-proxy.md`, `prd-002b-readiness-splash-ui.md`, `prd-002c-acceptance-and-tests.md`) and the pinned note `library/knowledge/private/frontend/portal-readiness-splash.md`
**Audit date:** 2026-07-01
**Base branch:** `feature/prd-001-hive-portal-daemon` (PRD-002 is a stack on top; PRD-001 is already implemented and QA'd on the base)
**Head:** `feature/prd-002-portal-readiness-splash` (uncommitted working tree, HEAD equals the base commit `50b216f`; all PRD-002 work, including the security remediation, is in the working tree, not yet committed)
**Auditor:** quality-worker-bee

## Ordering check

`security-worker-bee` ran first on this branch (`qa/security-report.md`, 2026-07-01). It found and remediated one Medium (SSRF-adjacent: the doctor status fetch did not pin `redirect`, so a rogue/compromised loopback listener on `:3852` could 3xx-redirect the fetch off loopback, defeating `isLoopbackBaseUrl()`'s defense-in-depth on fs-AC-9). The report's "Recommended Follow-Up" states "`quality-worker-bee` may now run against a security-clean tree." No `*-qa-report.md` predates this audit in the PRD-002 `qa/` folder. Ordering is correct; this audit proceeds.

## Summary

PRD-002's implementation is complete and correct: all 10 `fs-AC` (proxy route, fail-soft, `isFleetReady()`, tamper-safety) and all 9 `rs-AC` (splash-first render, polling, per-daemon grid, sticky gate into `SetupGate`) criteria are met with direct code and test evidence, and the cold-boot bug the pinned note documents is genuinely fixed: `SetupGate` (and therefore its `/setup/state` poll) cannot mount until `isFleetReady()` passes. The cross-repo contract holds: hive's `DoctorStatusSchema` is a compatible, strict-subset consumer of doctor's actual `StatusJson` shape (verified against the sibling `doctor` worktree's `src/status-page/server.ts` and `src/compose/index.ts`), with no field-name or enum mismatch. `npm run typecheck && npm test && npm run build` are green (15 files / 72 tests, up from the security-remediated baseline of 14 files / 66 tests). Two Warnings were found and fixed in place during this audit: (1) `prd-002c`'s test plan explicitly called for rendered-component tests covering rs-AC-2/3/5/6/7/9, but the shipped suite deferred them entirely (node-only vitest environment, no DOM test libs), closed by adding `jsdom` + `@testing-library/react` as devDependencies and a new render-behavior test file; (2) the execution ledger's PRD-002 tracking section was stale, describing the module as "documentation-only, no smoker run has started" against an actual implemented-and-security-remediated branch, corrected in place. No Critical findings. **Recommend shipping.**

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | 10/10 fs-AC, 9/9 rs-AC, 8/8 ac-AC all pass with code + test evidence; no ❌ rows. |
| Correctness   | ✅ | Behavior matches the plan precisely, including the `fleetGated` sticky-state pattern (an explicit, more robust realization of the pinned note's illustrative sketch) and the security-hardened `redirect: "error"` fetch. |
| Alignment     | ✅ | File placement matches `prd-002a`/`prd-002b`'s stated locations exactly (`src/daemon/fleet-status.ts`, `src/shared/fleet-readiness.ts`, `src/dashboard/web/readiness-splash.tsx`); the dedup refactor removed the one duplicate module; no out-of-scope files touched (`SetupGate`, `/api/daemon-bases`, `daemon-routing.ts` all unchanged). |
| Gaps          | ⚠️ | One real gap found and fixed: `prd-002c`'s test plan for rs-AC-2/3/5/6/7/9 was unimplemented (deferred by design, per the original test file's own comment) until this audit added it. |
| Detrimental   | ⚠️ | One doc-accuracy gap found and fixed: the ledger's PRD-002 row was stale relative to the actual branch state. No code-level regressions, dead code, or leftover debug artifacts found. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [x] **`prd-002c`'s rendered-component test plan for rs-AC-2/3/5/6/7/9 was unimplemented**, `tests/dashboard/readiness-splash.test.ts:1-6` (before fix)

  The original test file's own header comment read: *"Full render tests (rs-AC-2/3/5/6/7/9) are deferred: vitest uses node environment and includes only tests matching the .test.ts suffix with no DOM test libs installed."* This left the module's core behavior (the splash actually blocks `SetupGate`'s mount, actually renders the per-daemon grid with the right states, and actually stops polling once ready) verified only by manual code reading, not by an executable test, despite `prd-002c`'s test plan explicitly enumerating exactly these cases with a "mocked-fetch harness."

  **Fixed:** added `jsdom`, `@testing-library/react`, and `@testing-library/dom` as devDependencies (no new runtime dependency; zod remains the only PRD-002 runtime addition, already present); extended `vitest.config.ts`'s `include` glob to also match `tests/**/*.test.tsx`; added `tests/dashboard/readiness-splash-render.test.tsx` (jsdom environment via a per-file `@vitest-environment` pragma, so the rest of the suite keeps the faster `node` default) with six tests covering rs-AC-2, rs-AC-3, rs-AC-4, rs-AC-5, rs-AC-6, and rs-AC-7/rs-AC-9 (combined, since rs-AC-9's stickiness is the direct consequence of rs-AC-7's "polling stops" behavior in this implementation). Updated the stale deferral comment in `readiness-splash.test.ts` to point at the new file. All 72 tests pass; `npm run typecheck` and `npm run build` remain green.

  ```ts
  // tests/dashboard/readiness-splash-render.test.tsx (new)
  it("rs-AC-7 / rs-AC-9 mounts SetupGate once ready, stops polling, and stays mounted (sticky)", async () => {
    // ... drives ReadinessSplash from not-ready to ready via a mocked fetch queue ...
    await waitFor(() => expect(screen.queryByTestId("readiness-splash")).toBeNull());
    expect(screen.queryByTestId("guided-setup")).toBeTruthy();
    const callsAtTransition = fleetStatusCallCount();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fleetStatusCallCount()).toBe(callsAtTransition); // rs-AC-7
    expect(screen.queryByTestId("guided-setup")).toBeTruthy(); // rs-AC-9
  });
  ```

- [x] **Execution ledger's PRD-002 row was stale against the actual branch state**, `library/ledger/EXECUTION_LEDGER.md` (PRD-002 tracking section, before fix)

  The ledger read *"Documentation-only at this stage; no smoker run has started"* with status *"OPEN (blocked-on-doctor-004b...)"*, but the branch's working tree shows the full implementation (proxy route, splash UI, dedup refactor), a completed security remediation, and now this QA pass. This is the same class of drift PRD-001's own QA report caught and corrected for `m-AC-3`.

  **Fixed:** rewrote the PRD-002 tracking section to reflect the implemented/security-remediated/QA'd state, broke the single module-level row into `fs-AC-1..10` / `rs-AC-1..9` / `ac-AC-1..8` VERIFIED rows citing this report, and added a "PRD-002 run log" section (implementation, Close-out A, Close-out B) mirroring PRD-001's run-log format. Also added an explicit dependency note: doctor's `daemons[]` extension (the thing PRD-002 was "blocked" on) is now implemented in the sibling `doctor` worktree (`feature/prd-004a-004b-multi-daemon-status`) but is itself still uncommitted there, so the contract is authored-and-compatible (verified below), not yet a shipped doctor release. Neither branch is blocked on new work in the other; they should ship together.

## Suggestions (consider improving)

- [ ] **`prd-002-portal-readiness-splash-index.md`'s "Dependency status" section will read as stale once both branches ship**, `library/requirements/in-work/prd-002-portal-readiness-splash/prd-002-portal-readiness-splash-index.md:84-100`

  The index doc states doctor's `/status.json` "returns only coarse fleet health... with no per-daemon `daemons[]` array" and that the module "is BLOCKED on doctor `prd-004b` shipping this shape." As verified in this audit, that shape is already implemented in the sibling `doctor` worktree (not yet merged). Not a defect in this PRD's implementation, `library-worker-bee` owns updating this section once both branches land, flagging so it isn't lost.

## Plan Item Traceability

### fs-AC (prd-002a, fleet status proxy)

| ID | Criterion | Status | Implementation Location | Notes |
|---|---|---|---|---|
| fs-AC-1 | `GET /api/fleet-status` fetches doctor over loopback and returns normalized JSON; browser never opens `:3852` directly | ✅ | `src/daemon/server.ts:81-83`; `tests/daemon/fleet-status.test.ts:190-211` (`fs-AC-1 proxies doctor status through hive server`) | Route sits beside `/health`/`/api/daemon-bases` exactly as specified. |
| fs-AC-2 | Origin is a hard-coded loopback constant, never derived from registry/request/env | ✅ | `src/shared/constants.ts:9-10` (`DOCTOR_STATUS_URL`); `src/daemon/fleet-status.ts:47` (default param, not request-influenced); `tests/daemon/fleet-status.test.ts:107-109` | `doctorStatusUrl` is only injectable at `createHive()` construction (test seam), never per-request. |
| fs-AC-3 | doctor down/throwing → `{ supervisor: "unreachable", daemons: [] }`, 200 status | ✅ | `src/daemon/fleet-status.ts:53-57, 81-83`; `tests/daemon/fleet-status.test.ts:26-34, 213-224` | Covers both a thrown fetch and a non-200 response. |
| fs-AC-4 | Non-JSON/malformed body treated identically to fs-AC-3, no throw | ✅ | `src/daemon/fleet-status.ts:59-69`; `tests/daemon/fleet-status.test.ts:36-52` | Covers a `JSON.parse` throw and a zod validation failure. |
| fs-AC-5 | Well-formed body → `{ supervisor: "reachable", health, daemons, asOf }` pass-through | ✅ | `src/daemon/fleet-status.ts:71-80`; `tests/daemon/fleet-status.test.ts:54-93` | Also covers `daemons` defaulting to `[]` when the upstream field is absent (older doctor). |
| fs-AC-6 | `isFleetReady()` true only when `supervisor === "reachable"` AND `health === "ok"` AND every v1-required peer is `ok` | ✅ | `src/shared/fleet-readiness.ts:19-27`; `tests/daemon/fleet-status.test.ts:131-133, 184-186` | |
| fs-AC-7 | `degraded`/`unreachable`/`unknown` aggregate health → always `false`, no exception | ✅ | `src/shared/fleet-readiness.ts:23`; `tests/daemon/fleet-status.test.ts:135-160` | All three non-`ok` values tested individually. |
| fs-AC-8 | Required peer (`honeycomb`) missing from `daemons[]` → `false`, not vacuously true | ✅ | `src/shared/fleet-readiness.ts:24-26` (`.some(...)` over an absent match); `tests/daemon/fleet-status.test.ts:162-182` | Covers both "peer absent" and "daemons empty". |
| fs-AC-9 | Fetch target validated with `isLoopbackBaseUrl()` before use; defense-in-depth against redirect | ✅ | `src/daemon/fleet-status.ts:49-51` (loopback guard before fetch), `:42-54` (`redirect: "error"` pin, the security-worker-bee remediation) | `tests/daemon/fleet-status.test.ts:95-105` (non-loopback URL never fetched); `:111-120` (redirect mode pinned + fail-soft on redirect rejection). |
| fs-AC-10 | Client-facing body never echoes upstream headers/error detail; only the normalized shape crosses | ✅ | `src/daemon/fleet-status.ts:71-80` (builds only `{supervisor,health,daemons,asOf}`, drops `suggestedCommands`) | `tests/daemon/fleet-status.test.ts:226-241` asserts the exact key set and that `"3852"` never appears in the body. |

### rs-AC (prd-002b, readiness splash UI)

| ID | Criterion | Status | Implementation Location | Notes |
|---|---|---|---|---|
| rs-AC-1 | `main.tsx` renders `<ReadinessSplash assetBase={assetBase}>` wrapping `<SetupGate>`, replacing the direct `<SetupGate>` render | ✅ | `src/dashboard/web/main.tsx:17, 33-37`; `src/dashboard/web/readiness-splash.tsx:324-326` (renders `<SetupGate>` internally once gated) | |
| rs-AC-2 | Before the first `/api/fleet-status` response, shows the splash by default, never `SetupGate` | ✅ | `src/dashboard/web/readiness-splash.tsx:296-298, 324-328` (`fleetGated` initializes `false`) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-2 shows the splash by default before the first poll resolves`). |
| rs-AC-3 | `SetupGate` not mounted at all (not mounted-but-hidden) while the fleet gate has not passed | ✅ | `src/dashboard/web/readiness-splash.tsx:324-328` (mutually exclusive conditional render, not a CSS/visibility toggle) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-3 does not mount SetupGate (or fetch /setup/state) while the fleet is not ready`, asserts zero `/setup/state` fetch calls across two not-ready polls). |
| rs-AC-4 | Polls `GET /api/fleet-status` on a 1000-2000ms interval | ✅ | `src/dashboard/web/readiness-splash.tsx:296, 317` (`pollMs = 1500` default, used unmodified by `main.tsx`) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-4 defaults to a poll interval between 1000ms and 2000ms`, spies on `setInterval`'s delay argument). |
| rs-AC-5 | `supervisor: "reachable"` with non-empty `daemons[]` → one row per daemon, mapped `ok→up`/`degraded→degraded`/`unreachable→unreachable`/`unknown→starting` | ✅ | `src/dashboard/web/readiness-splash.tsx:31-46` (`deriveDaemonDisplayState`), `:217-272` (grid render) | `tests/dashboard/readiness-splash.test.ts:15-26` (pure mapping, all 4 cases) + `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-5 renders one row per daemon with the correctly mapped display state`, all 4 cases rendered together). |
| rs-AC-6 | `supervisor: "unreachable"` → distinct "waiting on doctor" state, not an empty grid | ✅ | `src/dashboard/web/readiness-splash.tsx:93-126, 135, 209-215` (`SupervisorUnreachableIndicator`, `data-testid="readiness-doctor-unreachable"`) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-6 shows the distinct doctor-unreachable indicator, not an empty grid`). |
| rs-AC-7 | Fleet becomes ready mid-poll → stops polling, renders `SetupGate` in the same tick, no intermediate blank frame | ✅ | `src/dashboard/web/readiness-splash.tsx:308-311` (`setFleetGated(true)` on `isFleetReady`), `:300-301` (effect early-returns once gated, no new interval), `:324-328` (single conditional swap, same render) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-7 / rs-AC-9 ...`, asserts `/api/fleet-status` call count stops increasing after the transition). |
| rs-AC-8 | Fleet ready + no credential → `SetupGate` proceeds through its own unmodified logic to `GuidedSetup` | ✅ | `src/dashboard/web/setup-gate.tsx` unchanged in this diff (confirmed via `git diff feature/prd-001-hive-portal-daemon...HEAD`, only `main.tsx` changed under `dashboard/web` for existing files); `setup-gate.tsx:401-445` (unmodified `SetupGate` phase switch) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-7 / rs-AC-9`) reaches `data-testid="guided-setup"` post-gate using `SetupGate`'s real, untouched logic (`FRESH_SETUP_STATE` default). |
| rs-AC-9 | A post-mount not-ready poll does not unmount an already-mounted `SetupGate`/`Shell` | ✅ | `src/dashboard/web/readiness-splash.tsx:300-301` (once `fleetGated` is `true`, the poll effect never runs again; polling stops permanently, so there is no mechanism by which a later "not ready" result could ever be observed) | `tests/dashboard/readiness-splash-render.test.tsx` (`rs-AC-7 / rs-AC-9 ...`) directly verifies `guided-setup` remains mounted after the transition with no further fetch activity. |

### ac-AC (prd-002c, consolidated acceptance, from the pinned note)

| ID | Criterion | Status | Notes |
|---|---|---|---|
| ac-AC-1 | Honeycomb stopped + doctor `degraded`/`unreachable` → splash only, never "First time setup" | ✅ | Traces to fs-AC-6/fs-AC-7 (both block on non-`ok`) + rs-AC-3 (SetupGate never mounts while not gated). |
| ac-AC-2 | Doctor `ok` + honeycomb row `ok` → splash dismisses into `SetupGate`/dashboard | ✅ | Traces to fs-AC-6, rs-AC-7, rs-AC-8, all verified above. |
| ac-AC-3 | Honeycomb up, no DeepLake credentials → guided setup reached | ✅ | Traces to rs-AC-8; `SetupGate` internals unchanged. |
| ac-AC-4 | Splash renders before any `/setup/state` or dashboard fetch | ✅ | Traces to rs-AC-1/rs-AC-2/rs-AC-3; directly asserted by the new render test's zero-`/setup/state`-calls check. |
| ac-AC-5 | Doctor down → splash persists, no setup mis-detection | ✅ | Traces to fs-AC-3, rs-AC-6. |
| ac-AC-6 | `/api/fleet-status` rejects non-loopback/tampered doctor URLs | ✅ | Traces to fs-AC-2, fs-AC-9 (hardened further by the security remediation). |
| ac-AC-7 | `health: "degraded"` + every named peer `ok` → still `false` (aggregate alone is sufficient to block) | ✅ | `tests/daemon/fleet-status.test.ts:135-142` directly tests this exact combination. |
| ac-AC-8 | `health: "ok"` but `honeycomb` missing from `daemons[]` → `false` | ✅ | `tests/daemon/fleet-status.test.ts:162-171` (identical to fs-AC-8). |

### Non-Goals

| Non-Goal | Status | Notes |
|---|---|---|
| No change to `SetupGate`'s internal logic | ✅ Honored | `setup-gate.tsx` not in the PRD-002 diff. |
| No change to `/api/daemon-bases` or the federated `wire`'s endpoint-owner routing | ✅ Honored | `src/shared/daemon-routing.ts` not in the PRD-002 diff. |
| No caching/debouncing beyond the browser's own poll interval | ✅ Honored | `fetchFleetStatus` (`src/daemon/fleet-status.ts:45-84`) does a fresh fetch every call; no memoization. |
| Visual polish deferred to `ux-ui-worker-bee`, scoped to the splash only | ✅ Honored | All new styling lives in `readiness-splash.tsx`; no shared token/primitive files touched. |
| nectar not a v1 gating peer | ✅ Honored | `V1_REQUIRED_PEERS = ["honeycomb"]` only (`src/shared/fleet-readiness.ts:19`); a `nectar` row, if present in `daemons[]`, renders via the same generic grid loop as a display-only row (`readiness-splash.tsx:231-270`), never consulted by `isFleetReady()`. |
| Degraded fleet health does not get an exception | ✅ Honored | fs-AC-7 / ac-AC-7. |

## Cross-repo contract alignment: hive proxy schema vs doctor `/status.json`

**Verdict: ALIGNED, no mismatch.**

| Field | doctor `StatusJson` (`doctor/src/status-page/server.ts:37-57`) | hive `DoctorStatusSchema` (`src/daemon/fleet-status.ts:21-33`) | Compatible? |
|---|---|---|---|
| `health` | `"ok" \| "degraded" \| "unreachable" \| "unknown"` | `z.enum(["ok","degraded","unreachable","unknown"])` | ✅ exact enum match |
| `daemons` | `readonly StatusJsonDaemon[]` (always an array; `compose/index.ts:624-634` always supplies it) | `z.array(FleetDaemonSchema).optional().default([])` | ✅ superset-tolerant (also degrades gracefully for an older doctor that omits it, per fs-AC-5) |
| `daemons[].name` | `string` | `z.string().min(1)` | ✅ |
| `daemons[].health` | same `StatusPageHealth` enum | same `FleetHealthSchema` | ✅ |
| `daemons[].escalation` | `NeedsAttentionFile \| null` | `z.unknown().nullable().optional()` | ✅ compatible; hive treats it opaquely by design (fs-AC-5/fs-AC-10: hive never interprets escalation internals) |
| `asOf` | `string` (ISO-8601, `compose/index.ts` / `server.ts:235`) | `z.string().min(1)` | ✅ |
| `escalation` (top-level) | present | not declared in hive's schema | ✅ harmless: zod's default `.object()` mode strips unknown keys rather than rejecting them, and hive's own response builder (`fleet-status.ts:71-80`) only emits `{supervisor,health,daemons,asOf}` regardless, so this field never reaches the browser (verified by `fs-AC-10`'s test) |
| `suggestedCommands` | present | not declared | ✅ same as above: stripped, never echoed |

Source verified: `doctor/src/status-page/server.ts:37-57` (`StatusJson`/`StatusJsonDaemon` interfaces) and `doctor/src/compose/index.ts:148-158, 624-645` (`aggregateDaemonHealth`, `readDaemonStatusRows`, the `createStatusPageServer` wiring), read directly from the sibling `doctor` worktree (`c:\Users\mario\GitHub\the-apiary-doctor-004`, branch `feature/prd-004a-004b-multi-daemon-status`).

**Caveat (not a hive defect):** doctor's `daemons[]` extension is itself uncommitted in that worktree (not yet merged to doctor's `main`); see the ledger dependency note above. The contract hive was authored against is real and compatible, but the two branches are companions that should land together, not a case of hive silently drifting from a shipped doctor contract.

## Cold-boot bug fix verification

Traced the render path end to end:

1. `src/dashboard/web/main.tsx:33-37`: the esbuild entry mounts `<ReadinessSplash assetBase={assetBase}>` as the **sole** top-level component. `SetupGate` is imported nowhere in `main.tsx` anymore (`readiness-splash.tsx:22` imports it instead).
2. `src/dashboard/web/readiness-splash.tsx:296-298`: `ReadinessSplash`'s initial state is `status: null`, `fleetGated: false`.
3. `src/dashboard/web/readiness-splash.tsx:324-328`: the render body is a hard `if (fleetGated) return <SetupGate .../>; return <FleetSplashGrid .../>;`. This is a **conditional mount**, not a CSS/visibility toggle: React never constructs the `SetupGate` element tree, so `SetupGate`'s `useEffect` (`setup-gate.tsx:408-427`, the one that fires the `/setup/state` poll) never runs, because the effect only runs after the component mounts.
4. `fleetGated` flips to `true` only inside the poll's `tick()` (`readiness-splash.tsx:308-311`), gated by `isFleetReady(next)` (`src/shared/fleet-readiness.ts:21-27`), which itself requires `supervisor === "reachable"` AND `health === "ok"` AND the `honeycomb` peer `ok`: the same three conditions the pinned note's acceptance sketch calls for.
5. Consequently, while honeycomb is still booting (doctor reports `degraded`/`unreachable`/`unknown`, or is itself unreachable), `fleetGated` never becomes `true`, `SetupGate` never mounts, `wire.setupState()`'s `FRESH_SETUP_STATE` fail-soft (the mechanism that produced the "First time setup" mis-detection) is never even reached, and the operator sees only the readiness splash's "Waiting for the hive…" copy and per-daemon grid.

This was previously verifiable only by manual code reading; it is now also directly asserted by `tests/dashboard/readiness-splash-render.test.tsx`'s `rs-AC-3` test, which renders the real component tree with a mocked "fleet not ready" response for two consecutive polls and asserts zero fetch calls to any URL containing `/setup/state`. **The cold-boot bug is genuinely fixed, not just structurally plausible.**

## Files Changed

- `library/ledger/EXECUTION_LEDGER.md` (M, this audit), corrected the stale PRD-002 tracking row; added `fs-AC`/`rs-AC`/`ac-AC` VERIFIED rows, a doctor-dependency note, and a PRD-002 run log.
- `library/requirements/in-work/prd-002-portal-readiness-splash/qa/qa-report-prd-002-portal-readiness-splash.md` (A, this audit), this report.
- `package.json` (M, this audit), added `jsdom`, `@testing-library/react`, `@testing-library/dom` as devDependencies (no new runtime dependency).
- `package.json` (M, PRD-002 implementation, prior to this audit), no runtime dependency changes; zod already present from PRD-001.
- `src/daemon/fleet-status.ts` (A, PRD-002), `fetchFleetStatus()`: loopback-pinned, zod-validated, fail-soft doctor status fetch; `redirect: "error"` pin (security remediation).
- `src/daemon/server.ts` (M, PRD-002), added `GET /api/fleet-status` route + `fleetStatusFetch`/`doctorStatusUrl` injectable seams.
- `src/dashboard/web/main.tsx` (M, PRD-002), top-level render swapped from `<SetupGate>` to `<ReadinessSplash>`.
- `src/dashboard/web/readiness-splash.tsx` (A, PRD-002), `ReadinessSplash` component, per-daemon grid, display-state mapping.
- `src/dashboard/web/fleet-readiness.ts` (D, PRD-002 dedup refactor), deleted; superseded by `src/shared/fleet-readiness.ts`.
- `src/shared/constants.ts` (M, PRD-002), added `DOCTOR_STATUS_URL`.
- `src/shared/fleet-readiness.ts` (A, PRD-002), shared `FleetStatusResponse`/`isFleetReady()`/`V1_REQUIRED_PEERS` (server + browser).
- `tests/dashboard/copy-map.test.ts` (M, PRD-002), file-count/inclusion updated for `readiness-splash.tsx` + `fleet-readiness.ts`.
- `tests/dashboard/readiness-splash-render.test.tsx` (A, this audit), closes the rs-AC-2/3/4/5/6/7/9 render-test gap (jsdom + `@testing-library/react`).
- `tests/dashboard/readiness-splash.test.ts` (M, PRD-002 + this audit), pure-function tests (`deriveDaemonDisplayState`, `isReady`); comment updated to point at the new render-test file.
- `tests/daemon/fleet-status.test.ts` (A, PRD-002 + security remediation), route + `isFleetReady()` + redirect-pinning tests.
- `vitest.config.ts` (M, this audit), `include` glob extended to `tests/**/*.test.tsx`.

## Verification commands run

- `hive`: `npm run typecheck`, **pass** (clean).
- `hive`: `npm test`, **pass** (15 files / 72 tests; baseline after security remediation was 14 files / 66 tests, +1 file / +6 tests from this audit's render-test addition).
- `hive`: `npm run build`, **pass** (`dist/daemon/dashboard/app.js` built); verified 0 occurrences of `require("node:`, `from"node:`, or bare `require(` in the built bundle (re-confirms security's prior bundle-purity finding after this audit's changes).

## Verdict

**Overall: PASS.** 0 Critical, 0 open Warnings (2 found and fixed in place during this audit), 1 Suggestion (a doc-freshness note for `library-worker-bee`, non-blocking). fs-AC: **10/10**. rs-AC: **9/9**. ac-AC: **8/8**. Cross-repo contract alignment (hive proxy schema vs doctor `/status.json`): **ALIGNED**. Cold-boot bug fix: **verified genuine**, both by code trace and by a new executable test. Gate green (`npm run typecheck && npm test && npm run build`, 15 files / 72 tests). **Shippable.** This PR stacks on PRD-001 (base `feature/prd-001-hive-portal-daemon`, already implemented and QA'd); no PRD-001 regression was found (all 15 files/72 tests include PRD-001's original suites unmodified except the one intentionally-updated `copy-map.test.ts` file count).
