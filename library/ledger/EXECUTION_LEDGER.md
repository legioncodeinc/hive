# Execution Ledger: PRD-001 hive Portal Daemon (the-smoker run)

> Category: Ledger | Version: 1.0 | Date: July 2026 | Status: Active

Single source of truth for the `/the-smoker` completion run over **PRD-001 hive Portal Daemon** (index + 001a/b/c/d). Branch: `feature/prd-001-hive-portal-daemon`. Status legend: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.

Greenfield implementation in `hive` (bare repo). Honeycomb cutover (retire `web/` subtree) runs in Wave 5 after hive serves.

---

## AC Ledger

| ID | Source | Criterion (exact) | Owner | Status |
|---|---|---|---|---|
| m-AC-1 | index | hive runs as its own OS process with `/health`, PID/lock, port 3853 | typescript-node-worker-bee | VERIFIED |
| m-AC-2 | index | Dashboard shell renders on socket bind before workload daemon health | typescript-node-worker-bee | VERIFIED |
| m-AC-3 | index | Same route registry + pages as retired honeycomb dashboard via injected `wire` | react-worker-bee | VERIFIED |
| m-AC-4 | index | No Deep Lake client; fail-soft per-daemon aggregation | typescript-node-worker-bee | VERIFIED (see QA Warning: UI-shell `daemonUp` gate is honeycomb-scoped, not per-daemon) |
| m-AC-5 | index | Independent release train (hive-only deploy surface) | typescript-node-worker-bee | OPEN (architectural separation confirmed; no CI/CD automation exists yet — see QA report) |
| m-AC-6 | index | honeycomb `/` + `web/` retired only after hive serves | typescript-node-worker-bee | VERIFIED |
| m-AC-7 | index | doctor supervises via idempotent registry entry, no doctor restart | typescript-node-worker-bee | VERIFIED |
| a-AC-1 | 001a | Hono app, dashboard mount, bind port 3853 | typescript-node-worker-bee | VERIFIED |
| a-AC-2 | 001a | `GET /health` returns `status` + `uptimeMs` + `version` | typescript-node-worker-bee | VERIFIED |
| a-AC-3 | 001a | Dashboard shell served immediately without waiting on daemon `/health` | typescript-node-worker-bee | VERIFIED |
| a-AC-4 | 001a | Writes `~/.honeycomb/hive.pid` and `hive.lock` | typescript-node-worker-bee | VERIFIED |
| a-AC-5 | 001a | Second start exits rather than double-bind | typescript-node-worker-bee | VERIFIED |
| a-AC-6 | 001a | Stale lock reclaimed when PID dead | typescript-node-worker-bee | VERIFIED |
| a-AC-7 | 001a | App construction pure; only `startHive` calls `listen()` | typescript-node-worker-bee | VERIFIED |
| b-AC-1 | 001b | Same `ROUTES` entries as honeycomb registry | react-worker-bee | VERIFIED |
| b-AC-2 | 001b | Pages hydrate through injected `wire` unchanged | react-worker-bee | VERIFIED |
| b-AC-3 | 001b | honeycomb removes `/` mount only after hive serves | typescript-node-worker-bee | VERIFIED |
| b-AC-4 | 001b | honeycomb keeps `/health` and `/api/*` after retirement | typescript-node-worker-bee | VERIFIED |
| b-AC-5 | 001b | Copy-map complete for all 36 dashboard files | react-worker-bee | VERIFIED |
| c-AC-1 | 001c | `wire` fetches each endpoint from owning daemon base | typescript-node-worker-bee | VERIFIED |
| c-AC-2 | 001c | nectar `/api/hive-graph/*` routed to nectar | typescript-node-worker-bee | VERIFIED |
| c-AC-3 | 001c | One daemon down degrades its panels only | typescript-node-worker-bee | VERIFIED (see QA Warning: data-layer fail-soft is correct; UI-shell connectivity gate is honeycomb-scoped, not per-daemon) |
| c-AC-4 | 001c | Malformed responses degrade via zod, no React throw | typescript-node-worker-bee | VERIFIED |
| c-AC-5 | 001c | No Deep Lake client in hive | typescript-node-worker-bee | VERIFIED |
| d-AC-1 | 001d | `install-service` writes platform unit (launchd/systemd/schtasks) | typescript-node-worker-bee | VERIFIED |
| d-AC-2 | 001d | Service starts hive on boot/login | typescript-node-worker-bee | VERIFIED |
| d-AC-3 | 001d | Service restarts hive on crash | typescript-node-worker-bee | VERIFIED |
| d-AC-4 | 001d | `uninstall-service` removes only hive unit | typescript-node-worker-bee | VERIFIED |
| d-AC-5 | 001d | hive unit execs hive entrypoint, not doctor | typescript-node-worker-bee | VERIFIED |
| d-AC-6 | 001d | Registry contains hive entry with name, healthUrl, pidPath | typescript-node-worker-bee | VERIFIED |
| d-AC-7 | 001d | Re-install updates entry in place (idempotent) | typescript-node-worker-bee | VERIFIED |
| d-AC-8 | 001d | Atomic JSON write; no doctor restart or code change | typescript-node-worker-bee | VERIFIED |

**Open count after Close-out B: 1 (m-AC-5, release-train CI automation — tracked as a Warning, not ship-blocking). All other 26 ACs VERIFIED.**

---

## PRD-002 tracking: Portal Readiness Splash

PRD-002 (index + 002a/002b/002c) was authored into `library/requirements/in-work/prd-002-portal-readiness-splash/` per the pinned note [`portal-readiness-splash.md`](../knowledge/private/frontend/portal-readiness-splash.md) (Option B locked). **Implemented** on branch `feature/prd-002-portal-readiness-splash` (uncommitted working tree, based on `feature/prd-001-hive-portal-daemon`): the `GET /api/fleet-status` proxy, `isFleetReady()`, `ReadinessSplash`, the `main.tsx` tree-order change, and a dedup refactor (`src/shared/fleet-readiness.ts` shared by the server and browser). `security-worker-bee` ran and remediated one Medium (SSRF redirect-follow on the doctor fetch); `quality-worker-bee` ran after and verified all 19 sub-PRD ACs. This corrects the prior "documentation-only, no smoker run has started" note below, which was stale as of this implementation pass.

| ID | Source | Criterion (exact) | Owner | Status |
|---|---|---|---|---|
| fs-AC-1..10 | 002a | `GET /api/fleet-status` loopback-only proxy, fail-soft, `isFleetReady()`, tamper-safety | typescript-node-worker-bee | VERIFIED (10/10; see QA report) |
| rs-AC-1..9 | 002b | `ReadinessSplash` wraps `SetupGate`, polls, per-daemon grid, sticky gate | react-worker-bee | VERIFIED (9/9; see QA report) |
| ac-AC-1..8 | 002c | Consolidated acceptance sketch + the locked "no exception for degraded" rule | typescript-node-worker-bee | VERIFIED (traced via fs-AC-*/rs-AC-* evidence; see QA report) |

**Dependency note (doctor `daemons[]`):** the pinned note and `prd-002-portal-readiness-splash-index.md`'s "Dependency status" section describe this module as blocked on nectar `prd-004b` extending `GET :3852/status.json` with a `daemons[]` array. As of this QA pass, that extension is implemented in the sibling `doctor` worktree (`src/status-page/server.ts` `StatusJson.daemons`, `src/compose/index.ts`) on branch `feature/prd-004a-004b-multi-daemon-status`, but it is **uncommitted there too** (not yet merged to doctor's own `main`), so the dependency is authored-and-compatible, not yet shipped. `quality-worker-bee` verified hive's `DoctorStatusSchema` (`src/daemon/fleet-status.ts:29-33`) is a compatible strict-subset consumer of doctor's actual `StatusJson` shape (field names, enum values, and per-daemon `escalation` all align); see the QA report's cross-repo contract-alignment section. The two branches should ship together; neither is blocked on new work in the other.

Report: `qa/qa-report-prd-002-portal-readiness-splash.md`.

---

## Wave plan

```mermaid
flowchart TD
    w1["Wave 1: scaffold + 001a process/bootstrap"] --> w2["Wave 2: 001b dashboard copy + esbuild host"]
    w2 --> w3["Wave 3: 001c federated wire + registry routing"]
    w3 --> w4["Wave 4: 001d service unit + registry install"]
    w4 --> w5["Wave 5: honeycomb dashboard retirement cutover"]
    w5 --> sec["Close-out A: security-worker-bee"]
    sec --> qa["Close-out B: quality-worker-bee"]
    qa --> ship["Ship: commit + push + PR + CI"]
```

| Wave | Bee | Model | Scope | Exit criteria |
|---|---|---|---|---|
| 1 | `typescript-node-worker-bee` | `gpt-5.3-codex-high-fast` | Greenfield `package.json`, tsconfig, vitest, Hono server, lock, `/health`, `createHive`/`startHive`, minimal dashboard host stub | a-AC-* DONE; `npm run typecheck && npm test` green |
| 2 | `typescript-node-worker-bee` + `react-worker-bee` | `claude-opus-4-8-thinking-high-fast` | Copy 28 `web/` files + partial `contracts.ts`; esbuild browser bundle; adapt `host.ts`/`web-assets` from honeycomb | b-AC-1, b-AC-2, b-AC-5 DONE; dashboard builds |
| 3 | `typescript-node-worker-bee` | `gpt-5.5-medium-fast` | Federated `wire.ts`, registry reader, endpoint-owner map, fail-soft | c-AC-* DONE |
| 4 | `typescript-node-worker-bee` | `gpt-5.3-codex-high-fast` | Service install/uninstall mirroring doctor; registry RMW | d-AC-* DONE |
| 5 | `typescript-node-worker-bee` | `composer-2.5-fast` | honeycomb: remove `/` mount + delete `web/` after hive verified | b-AC-3, b-AC-4, m-AC-6 DONE |
| 6a | `security-worker-bee` | `claude-sonnet-5-thinking-high` | Security audit + remediate Critical/High | clean at medium+ |
| 6b | `quality-worker-bee` | `claude-sonnet-5-thinking-high` | QA vs PRD-001 ACs | all ACs VERIFIED |

---

## Scope boundaries

- Primary code owner: `hive/` repository root (not apiary umbrella docs except ledger/PRD lifecycle).
- Reference only (do not import at runtime): `../honeycomb/`, `../doctor/`.
- Honeycomb retirement (Wave 5) touches `honeycomb/` submodule; only after hive serves dashboard on :3853.
- Do not modify nectar or doctor source except honeycomb cutover in Wave 5.

---

## Run log

- Phase 0: PRD moved `backlog/` -> `in-work/`; branch `feature/prd-001-hive-portal-daemon` created; ledger initialized (29 OPEN).
- Wave 1: DONE (greenfield scaffold and PRD-001a process/bootstrap implemented in `hive/src` and `hive/tests`).
- Wave 1 verification evidence:
  - `npm run typecheck` passes.
  - `npm test` passes (2 files, 8 tests).
  - `npm run build` passes (`tsc && node esbuild.config.mjs`).
- Wave 2: DONE (PRD-001b dashboard migration — b-AC-1, b-AC-2, b-AC-5 DONE; m-AC-3 IN PROGRESS/partial).
  - Copied the 28 honeycomb `web/` files VERBATIM into `hive/src/dashboard/web/` (12 shell/infra + 12 pages + wire.ts/app.tsx/main.tsx/setup-gate.tsx). For Wave 2 the four "copy with modification" files needed no code change: the dashboard pages are origin-agnostic and the asset-base/path adaptation is localized to the host shell (`data-asset-base=""`) and `web-assets.ts` (font prefix `/fonts/`). wire.ts keeps honeycomb's same-origin `/api/*` endpoint map + zod schemas; Wave 3 (PRD-001c) federates it.
  - Copied the PARTIAL `contracts.ts` (only the web-consumed ROI view-model types wire.ts + roi pages import) to `hive/src/dashboard/contracts.ts`.
  - Import fix: two verbatim pages import shared modules outside the web tree (`settings.tsx` → `../../../shared/lifecycle-flags.js`, `memories.tsx` → `../../../shared/memory-types.js`). Copied both pure/browser-safe modules to `hive/src/shared/` so the relative imports resolve and the pages stay byte-verbatim (no page edit).
  - Copied `assets/styles.css`, `assets/tokens/*`, `assets/logos/honeycomb-memory-cluster.svg` into `hive/assets/`.
  - Adapted `src/daemon/dashboard/web-assets.ts` from honeycomb (font prefix `/fonts/`, bundle name `app.js`).
  - Replaced `src/daemon/dashboard/host.ts` with the full shell serving at `/`, `/app.js`, `/styles.css`, `/honeycomb-memory-cluster.svg`, `/fonts/:name`.
  - Replaced `esbuild.config.mjs` to bundle `src/dashboard/web/main.tsx` → `dist/daemon/dashboard/app.js` (browser platform, esm, jsx automatic, React bundled, minified).
  - Added deps: `react` 18.3.1, `react-dom` 18.3.1, `zod` ^4.4.3, `@types/react` ^18.3.31, `@types/react-dom` ^18.3.7. tsconfig gained `jsx: react-jsx`, DOM libs, `esModuleInterop`, and `.tsx` includes.
- Wave 2 verification evidence:
  - `npm run typecheck` passes (whole `src` incl. the copied `.tsx` tree).
  - `npm run build` passes; emits `dist/daemon/dashboard/app.js` (~672 KB, React + ReactDOM + app).
  - `npm test` passes (5 files, 18 tests) incl. `tests/dashboard/registry.test.ts` (b-AC-1 labels/routes), `tests/dashboard/host.test.ts` (GET `/` → `#root` + `/app.js` script), `tests/dashboard/copy-map.test.ts` (b-AC-5 28-file count + partial contracts + shared modules).
- Wave 3: DONE (PRD-001c federated wire and doctor registry routing implemented).
  - Added `src/shared/daemon-routing.ts` for the static endpoint owner map: honeycomb owns copied dashboard endpoints by default, while `/api/hive-graph/*` routes to nectar.
  - Added `src/daemon/registry.ts` to read `~/.honeycomb/doctor.daemons.json`, validate entries with zod, derive daemon bases from `healthUrl`, and fall back to documented loopback defaults when the registry is missing or malformed.
  - Added `GET /api/daemon-bases` in `src/daemon/server.ts`; the browser wire uses this bootstrap endpoint instead of reading the filesystem.
  - Modified `src/dashboard/web/wire.ts` with the daemon-bases architecture: fetch bases once from hive, wrap fetch so each endpoint is sent to the owning daemon base, and keep existing zod parse/fail-soft return values. The SSE log stream now resolves its honeycomb URL asynchronously before constructing `EventSource`.
- Wave 3 verification evidence:
  - `npm run typecheck && npm test && npm run build` passes (8 files, 27 tests; dashboard bundle rebuilt).
  - `tests/wire/federation.test.ts` covers c-AC-1 and c-AC-2 endpoint ownership and URL construction.
  - `tests/wire/registry.test.ts` covers registry parsing, `/health` stripping, and missing or malformed registry fallback.
  - `tests/wire/fail-soft.test.ts` covers daemon-base bootstrap, fetch failure empty states, and malformed JSON empty states.
  - `tests/daemon/server.test.ts` covers `/api/daemon-bases` returning registry-derived bases.
  - Deep Lake import audit: `rg` found no `deeplake` imports or requires under `hive/src`.
  - Aikido scan attempted twice; MCP returned no structured issues, but the local Opengrep runner exited with code 2 and Checkov was missing, so no actionable Aikido finding was available to remediate.
- Wave 4: DONE (PRD-001d service-unit install/uninstall and doctor registry registration implemented).
  - Added `src/service/` module (`platform.ts`, `templates.ts`, `commands.ts`, `index.ts`) mirroring doctor's resolve/plan/render/command flow with hive-specific constants (`label: hive`, `thehive.service`, Windows task `hive`) and exec target `node <hive-cli> start`.
  - Added `src/install/registry.ts` read-modify-write registration for `~/.honeycomb/doctor.daemons.json` with idempotent upsert by `name: "hive"` and atomic temp-file plus rename writes.
  - Extended `src/cli.ts` command surface: `start`, `install-service`, `uninstall-service`, `register`; `install-service` now installs the platform unit and registers hive in the doctor registry.
  - Added test coverage: `tests/service/{helpers,platform,templates,service-module}.test.ts` and `tests/install/registry.test.ts`.
- Wave 4 verification evidence:
  - `npm run typecheck && npm test` passes.
  - Vitest totals: 12 files, 40 tests, all passing.
- Wave 5: DONE (honeycomb dashboard web portal retirement / ADR-0001 cutover).
  - Removed `mountDashboardHost` from `honeycomb/src/daemon/runtime/assemble.ts` (local-mode block now mounts setup API routes only: `/setup/login`, `/setup/state`, `/setup/migrate-from-hivemind`).
  - Deleted `honeycomb/src/dashboard/web/` (28 files), `honeycomb/src/daemon/runtime/dashboard/host.ts`, and `web-assets.ts`.
  - Removed dashboard-web esbuild bundle from `honeycomb/esbuild.config.mjs`.
  - Kept honeycomb `/health`, all `/api/*` route groups, ViewBlock/TUI layer (`dashboard.ts`, `views.ts`, `html.ts`, `launch.ts`, `logs.ts`, `contracts.ts`), and setup routes for hive wire client.
  - Updated `honeycomb install` / `openDashboard` portal URLs to hive `:3853/`.
- Wave 5 verification evidence:
  - `cd honeycomb && npm run typecheck` passes.
  - `cd honeycomb && npm test` passes (assemble + assembled-net + setup + install suites green).
  - `GET /health` and `GET /api/diagnostics/kpis` remain on assembled honeycomb daemon; `GET /dashboard` no longer served by honeycomb.
- Close-out A: DONE (`security-worker-bee` audit of PRD-001 — `hive` primary + honeycomb cutover delta).
  - Scope: loopback binding, font/static path traversal, registry JSON write safety, federated wire fetch (SSRF), portal-shell credential leakage, CLI service-install command injection.
  - Found + fixed 1 High: `daemon/registry.ts` / `dashboard/web/wire.ts` accepted a non-loopback daemon base from the doctor registry or `/api/daemon-bases`, letting a tampered registry redirect federated wire traffic (incl. captured session/memory POST bodies) off-loopback. Added `isLoopbackBaseUrl()` (`shared/daemon-routing.ts`) and gated both the server-side registry reader and the client-side `DaemonBasesSchema` on it.
  - All other scoped areas (loopback binding, font/static allow-list, registry atomic write, portal-shell token handling, `execFile`-only service install) reviewed clean. 2 Low findings documented (registry file mode, no explicit CORS/anti-CSRF header on unauthenticated GET routes) — follow-up only, not blocking.
  - Verification: `npx tsc --noEmit` clean; `npx vitest run` 12 files / 41 tests passing after remediation.
  - Report: `hive/library/requirements/in-work/prd-001-hive-portal-daemon/qa/security-report.md`.
  - Clean at medium+ (no unresolved Critical/High). `quality-worker-bee` may now run (Close-out B).
- Close-out B: DONE (`quality-worker-bee` audit of PRD-001 against the index + 001a/b/c/d ACs).
  - Verified 26 of 27 sub-PRD/module ACs PASS with direct code + test evidence; `npm run typecheck && npm test && npm run build` green in `hive` (12 files / 41 tests), plus `honeycomb` typecheck + the 4 cutover-relevant suites (68 tests) green after the Wave 5 delta.
  - 0 Critical findings. 2 Warnings: (1) the dashboard shell's `daemonUp` connectivity gate (`app.tsx`) checks honeycomb's `/health` only, not per-daemon — data-layer fail-soft (c-AC-1..4) is correct, but the UI-shell gate will incorrectly blank a future nectar-owned page; (2) m-AC-5 (independent release train) has the architectural separation but no CI/CD automation yet, correctly left `OPEN` rather than flipped. 2 Suggestions (stale honeycomb `CONVENTIONS.md` reference to the removed `mountDashboardHost` seam; a two-daemon isolation test gap to close once a nectar page ships).
  - Corrected a ledger-accuracy drift: m-AC-3 had been left `IN PROGRESS` despite its underlying b-AC-1/b-AC-2 being `DONE` and fully tested; flipped to `VERIFIED` on evidence.
  - Verdict: PASS with Warnings. Shippable. Report: `hive/library/requirements/in-work/prd-001-hive-portal-daemon/qa/qa-report-prd-001-hive-portal-daemon.md`.

## PRD-002 run log

- Implementation: DONE (branch `feature/prd-002-portal-readiness-splash`, based on `feature/prd-001-hive-portal-daemon`; uncommitted working tree). Added `src/shared/fleet-readiness.ts` (shared `isFleetReady()`/`V1_REQUIRED_PEERS`, browser-safe), `src/daemon/fleet-status.ts` (`GET /api/fleet-status` fetch/parse/fail-soft), `src/dashboard/web/readiness-splash.tsx` (`ReadinessSplash`), and rewired `src/dashboard/web/main.tsx` to render `<ReadinessSplash>` in place of the direct `<SetupGate>` mount. Deleted a duplicate `src/dashboard/web/fleet-readiness.ts` in favor of the shared module.
- Close-out A: DONE (`security-worker-bee`). Found + fixed 1 Medium: the doctor status fetch used native `fetch`'s default `redirect: "follow"`, so a rogue/compromised loopback listener on `:3852` could 3xx-redirect off loopback, defeating `isLoopbackBaseUrl()`'s defense-in-depth (fs-AC-9). Fixed by pinning `redirect: "error"`; covered by two new tests. All other reviewed surfaces (loopback pinning, response-body normalization/fs-AC-10, zod boundary, splash gating, bundle purity) clean. Report: `qa/security-report.md`.
- Close-out B: DONE (`quality-worker-bee`). Verified fs-AC-1..10 (10/10) and rs-AC-1..9 (9/9) with direct code + test evidence; confirmed the cold-boot bug fix (the splash genuinely blocks `SetupGate`'s mount, so `/setup/state` cannot fire before the fleet gate passes); confirmed hive's `DoctorStatusSchema` is a compatible consumer of doctor's actual `StatusJson` shape (no cross-repo mismatch). Found and fixed two Warnings in place: (1) `prd-002c`'s test plan called for rendered-component tests (rs-AC-2/3/5/6/7/9) that the original suite explicitly deferred (node environment, no DOM libs); added `jsdom` + `@testing-library/react` as devDependencies and a new `tests/dashboard/readiness-splash-render.test.tsx` closing the gap; (2) this ledger's PRD-002 tracking section was stale ("documentation-only, no smoker run has started") against the actual implemented-and-remediated state; corrected above. `npm run typecheck && npm test && npm run build` green (15 files / 72 tests). 0 Critical findings. Verdict: PASS. Report: `qa/qa-report-prd-002-portal-readiness-splash.md`.
