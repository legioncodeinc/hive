# QA Report: PRD-003b fleet lifecycle (hive scope: `stop` + three-part `uninstall`)

**Plan document:** superproject `library/requirements/backlog/prd-003-fleet-lifecycle-login-and-uninstall/prd-003b-fleet-lifecycle-login-and-uninstall-lifecycle-command-parity.md` (hive scope: b-AC-1..6; module AC-8/AC-9)
**Audit date:** 2026-07-05
**Base branch:** uncommitted working tree on `feature/fleet-lifecycle` (hive repo)
**Head:** working tree (10 modified files, 4 untracked; nothing committed per commission)
**Auditor:** quality-worker-bee (armed with quality-stinger)
**Ordering:** `security-worker-bee` ran first (report: `library/qa/security/2026-07-04-security-audit-prd-003-fleet-lifecycle.md`); its M-1 was remediated by the security bee and M-2 by the W3-Vfix cycle (ServiceUninstallResult `alreadyAbsent` classifier). Ordering is clean.
**Ledger:** superproject `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md`

## Summary

**Verdict: PASS with remediation.** All six hive-scope b-AC rows plus AC-8/AC-9 trace to code and AC-named tests; the M-2 classifier fix holds without regressing the b-AC-2 ordering contract or the M-1 legacy best-effort posture; `start`, `install-service`, and `register` are behavior-identical to base. One Warning was found and remediated in place (the `uninstall` failure path printed a contradictory "hive uninstalled." success line before exiting 1, an AC-9 copy defect), and all three W2 LOW coverage gaps were ruled cheap-and-meaningful and closed with 7 new tests. Post-remediation gate: `npm run typecheck` exit 0; `npm test` 64 files, 487/487 pass (the 4 documented machine-local tenancy flake suites passed in both runs).

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | Every hive-scope plan item (b-AC-1..6, AC-8/9) implemented with AC-named tests; W2's three LOW coverage gaps now closed. |
| Correctness   | ✅ | Classifier is conservative (unmatched failures stay genuine); registry delete is atomic temp+rename; state-dir removal is containment- and symlink-guarded. One AC-9 copy defect fixed (W-1). |
| Alignment     | ✅ | Bare-verb spelling per orchestrator decision 4; uninstall = unit + registry entry + state dir, npm package untouched per decision 5; immediate `stop` per decision 6. |
| Gaps          | ✅ | No unimplemented plan items. Security's L-1..L-3 remain documented Lows (below the medium+ remediation bar), not re-litigated here. |
| Detrimental   | ✅ | No duplication, no shell interpolation (fixed argv over enumerated constants via `execFile`), no new deps, telemetry stays on the closed allow-list chokepoint. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [x] **W-1 (REMEDIATED): `uninstall` failure path printed a contradictory success line**, `src/cli-commands.ts:250-261` (pre-fix `:251`)

  On a genuine current-unit deregister failure the verb printed the underlying error, then still printed `hive uninstalled.` before returning exit 1. AC-9 requires the flow to "fail with a plain-language, actionable error"; a success line on the failure path trains operators to ignore the exit code (the exact habit security's M-1 called out). Remediated in place: the success line now prints only on the exit-0 path; the failure path prints "hive uninstall completed with errors: the service unit may still be registered. Fix the error above and re-run 'hive uninstall'." Locked in by the strengthened test `M-2 a genuine current-unit failure exits nonzero naming the underlying failure` (`tests/cli-commands.test.ts:509-512`), which now also asserts the success line is absent.

  ```ts
  // pre-fix: printed unconditionally, then returned 1 on genuine failure
  out("hive uninstalled.\n");
  return serviceResult.ok || serviceResult.alreadyAbsent ? 0 : 1;
  ```

## Suggestions (consider improving)

- [ ] **S-1: `runUninstallCommand` constructs the service module twice**, `src/cli-commands.ts:202,221`

  When `deps.service` is not injected, `hiveHasInstallArtifacts` builds one `ServiceModule` and `runUninstallCommand` builds a second. Both are cheap stateless objects so this is cosmetic, but hoisting the construction once would remove the duplicate `createServiceModule({ execPath })` call.

- [ ] **S-2: registry-step errors lack the per-step friendly handling the state-dir step has**, `src/cli-commands.ts:231`, `src/install/registry.ts:171-179`

  A non-ENOENT read error (EACCES, EISDIR) on a registry candidate propagates out of `deleteHiveFromDoctor` and is caught only by the top-level `cli.ts:52-56` handler (message printed, exit 1, no stack trace), so the verb aborts before the state-dir step. Already documented as security L-2; carried here as a resilience suggestion only.

## Commissioned items

### 1. W2's three LOW coverage gaps: ruled and closed

All three were cheap (existing fake/memory-fs idioms) and meaningful (each guards an AC-bearing branch), so per the commission each got a test rather than a waiver:

| Gap | Ruling | Test added |
|---|---|---|
| (a) Real `service.isRegistered()` per-platform logic untested (`src/service/index.ts:259-283`) | Add. `isRegistered` is the input to b-AC-6 no-op detection; doctor's b-AC-6 was reopened in W2 for exactly this misclassification class. | 4 tests in `tests/service/service-module.test.ts:224-296`: systemd current-unit-file keying (and no manager command run), launchd legacy-only unit file, win32 current-then-legacy `schtasks /Query` fan-out with exact argv, and unsupported-platform answering `false` instead of throwing. |
| (b) `deleteHiveFromDoctor` default multi-path fan-out untested without `registryPath` override (`src/install/registry.ts:201-218`) | Add. The three-candidate chain (write path, fleet path, legacy path, deduped) is the b-AC-3 production path; every prior test bypassed it. A fully in-memory `RegistryFs` keeps it hermetic while the real resolvers compute the candidates. | 2 tests in `tests/install/registry.test.ts:202-246`: hive removed from every candidate that holds it (siblings preserved, `registryPaths` matches the deduped set) and absent candidates skipped while the one holding hive is rewritten. |
| (c) `stop` when registered, `service.stop()` genuinely fails, process still running (`src/cli-commands.ts:159-167`) | Add. This is the only stop branch that must exit 1, and it is the AC-9 honesty branch. | 1 test in `tests/cli-commands.test.ts:332-354`: exit 1, underlying error surfaced, and the "not running" no-op copy not printed. |

### 2. M-2 classifier fix: no regression of b-AC-2 ordering or M-1 posture

- **b-AC-2 ordering holds.** `uninstall()` still runs the legacy pass before the current pass (`src/service/index.ts:387-388`), and the exact-argv contract test `b-AC-2 uninstall deregisters legacy and current units` (`tests/service/service-module.test.ts:88-131`) still asserts `calls[0]` = legacy `systemctl --user disable --now thehive.service`, `calls[1]` = current `hive.service`, both unit files removed. Passing in both gate runs.
- **M-1 posture holds.** The legacy `runAll` result is deliberately ignored (`src/service/index.ts:384-387`); only the current-unit pass gates `ok`, and the `isAlreadyAbsentFailure` classifier (`src/service/index.ts:218-234`) examines only the current-unit `firstFailureResult`. A legacy-only failure can never flip the verdict or be misread as `alreadyAbsent`.
- **Classifier is conservative.** Launchd keys on the locale-independent exit 3 plus a not-found text fallback; systemd/schtasks on the text fallback only; anything unmatched stays a genuine failure with the underlying error surfaced via `describeFailure` (`src/service/index.ts:199-206`), proven by the "genuine current-unit failure" tests at module and verb level. A never-guarded `switch` keeps the manager union exhaustive.

### 3. Regression sweep

| Surface | Result |
|---|---|
| `start` | Byte-identical. `runStartCommand` (`src/cli-commands.ts:47-69`) and the `start` dispatch case plus the bare-invocation default (`src/cli.ts:18,23-25`) are untouched by the diff. |
| `install-service` | Byte-identical. `runInstallServiceCommand` and `service.install()` untouched; the d-AC-1 and rr-AC-10 install contract tests pass unchanged. |
| `uninstall-service` | Intentionally NOT byte-identical; changes are the recorded security remediations, not drift: (1) `service.uninstall()` now runs the best-effort legacy deregister pass and removes the legacy unit file (M-1 fix + b-AC-2 "best-effort legacy label"); (2) exit code treats `alreadyAbsent` as 0 (M-2 fix, `src/cli-commands.ts:114-118`); (3) failure messages carry the underlying manager error (AC-9). All three are ledger-recorded (2026-07-05 00:05 and 00:14 entries) and covered by the M-1/M-2 tests. No unintended behavior change found beyond these. |
| `register` | Byte-identical. `runRegisterCommand` (`src/cli-commands.ts:127-136`) and its dispatch case untouched. |
| README verb list | Accurate. `README.md:159-164` lists exactly the six verbs `cli.ts` dispatches (`start`, `stop`, `install-service`, `uninstall-service`, `uninstall`, `register`) with truthful one-liners; the usage line (`src/cli.ts:14`) matches. |
| Onboarding / dashboard | Untouched. The diff touches only the CLI, service, registry, and state-dir modules plus their tests; nothing under `src/daemon/`, `src/onboarding`, or dashboard assets. |

### 4. AC-9 copy and exit codes

| Flow | Message | Exit | Verdict |
|---|---|---|---|
| `stop`, not running (any path) | `hive is not running.` | 0 | Plain no-op. ✅ |
| `stop`, service success | `hive service stopped (<manager>).` | 0 | ✅ |
| `stop`, already stopped | `hive service was already stopped (<manager>).` | 0 | ✅ |
| `stop`, SIGTERM fallback | `Sent SIGTERM to hive (pid <n>).` | 0 | ✅ |
| `stop`, genuine failure | `A service-manager stop command (<cmd>) reported an error: <real error>.` | 1 | Actionable (names command + underlying error, capped at 200 chars). ✅ |
| `uninstall`, not installed | `hive is not installed; nothing to remove.` | 0 | b-AC-6 verbatim intent. ✅ |
| `uninstall`, success | Step lines + `hive uninstalled.` | 0 | ✅ |
| `uninstall`, unit already absent | `hive <manager> unit was already absent (nothing to remove).` + `hive uninstalled.` | 0 | ✅ |
| `uninstall`, genuine deregister failure | Underlying error + `hive uninstall completed with errors: the service unit may still be registered. Fix the error above and re-run 'hive uninstall'.` | 1 | ✅ after W-1 remediation (pre-fix it printed `hive uninstalled.` here). |
| `uninstall`, state-dir removal failure | `Could not remove hive state dir: <error>.` | 1 | No success line printed. ✅ |
| `uninstall-service`, already absent | `hive <manager> unit was already absent (nothing to remove).` | 0 | ✅ |

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| b-AC-1 | `start` and `stop` on macOS/Linux/Windows | ✅ | `src/cli-commands.ts:155-189`, `src/service/commands.ts:40-49`, `src/service/index.ts:337-370` | `start` pre-existing; `stop` fronts the manager (`bootout` / `systemctl stop` / `schtasks /End`) with a PID/SIGTERM direct fallback. Tests: `tests/service/commands.test.ts`, stop-verb suite. |
| b-AC-2 | `uninstall` removes the unit, current label plus best-effort legacy | ✅ | `src/service/index.ts:372-423`, `src/service/commands.ts:51-76` | Legacy pass best-effort (result ignored), current pass gates verdict; both unit files removed. Test `b-AC-2 uninstall deregisters legacy and current units`. |
| b-AC-3 | Registry entry deleted, siblings intact | ✅ | `src/install/registry.ts:171-218` | Atomic temp+rename per candidate path; fan-out over write/fleet/legacy paths now directly tested (gap (b)). |
| b-AC-4 | State dir removed, nothing else | ✅ | `src/install/state-dir.ts:33-48` | Containment check + symlink refusal; `~/.deeplake` and other products never touched (no code path reaches them). Tests in `tests/install/state-dir.test.ts`. |
| b-AC-5 | Existing spellings keep working | ✅ | `src/cli.ts:22-45` | `start` (and bare default), `install-service`, `uninstall-service`, `register` dispatch cases untouched. `uninstall-service` behavior deltas are the recorded M-1/M-2 remediations (see sweep). |
| b-AC-6 | Uninstall on a not-installed product exits 0, "nothing to remove" | ✅ | `src/cli-commands.ts:198-218`, `src/service/index.ts:259-283` | Keys on registration (unit file / task query), registry entry, and state dir presence; `isRegistered` per-platform logic now directly tested (gap (a)). |
| AC-8 (hive scope) | Nothing outside the allow-list; clean-machine no-op exits 0 | ✅ | `src/install/state-dir.ts:37-44`, `src/install/registry.ts:184` | Absolute resolved paths only, no globs; entry-level registry filter (never wholesale); no-op path proven by the b-AC-6 test. |
| AC-9 (hive scope) | Terminates with clear success or plain actionable error | ✅ | `src/cli-commands.ts:114-118,155-261`, `src/service/index.ts:199-234` | All commands bounded by `SERVICE_COMMAND_TIMEOUT_MS` (15s); copy table above. W-1 fixed the one contradictory line. |
| NG (003b) | No npm package removal, no `~/.deeplake`, no login changes, no registry schema change | ✅ | n/a | Diff contains no npm, credentials, or schema surface; registry delete follows the existing document shape. |

## Remediations performed (in place, not committed)

| File | Change |
|---|---|
| `src/cli-commands.ts` | W-1: success line `hive uninstalled.` now prints only on the exit-0 path; the genuine-failure path prints an honest "completed with errors" line naming the consequence and the re-run action. |
| `tests/cli-commands.test.ts` | Gap (c) test (genuine stop failure while running exits 1 with the error); W-1 assertions added to the existing genuine-failure uninstall test. |
| `tests/install/registry.test.ts` | Gap (b): in-memory `RegistryFs` helper + 2 default-candidate fan-out tests. |
| `tests/service/service-module.test.ts` | Gap (a): 4 `isRegistered` tests (systemd file keying, launchd legacy-only, win32 current-then-legacy query argv, unsupported platform). |

## Gate output

- Pre-remediation baseline: `npm run typecheck` exit 0; `npm test` (vitest) 64 files, **480/480 passed**, 5.37s.
- Post-remediation: `npm run typecheck` exit 0; `npm test` 64 files, **487/487 passed** (7 new tests), 4.92s.
- The 4 documented machine-local tenancy flake suites (`tests/dashboard/{tenancy-step,login-step-tenancy,prd-011-tenancy}`, `tests/daemon/setup-tenancy`) passed in both runs; the flake did not reproduce.

## Files Changed

- `README.md` (M), adds `hive stop` and `hive uninstall` to the CLI verb list.
- `library/qa/security/2026-07-04-security-audit-prd-003-fleet-lifecycle.md` (A), security-worker-bee report (predates this audit).
- `src/cli-commands.ts` (M), `stop` and three-part `uninstall` verb runners; `alreadyAbsent`-aware exit codes; W-1 failure-path copy fix.
- `src/cli.ts` (M), dispatch cases and usage line for `stop`/`uninstall`; existing cases untouched.
- `src/install/registry.ts` (M), `deleteHiveFromDoctor` (atomic three-candidate delete) and `registryContainsHiveEntry`.
- `src/install/state-dir.ts` (A), containment- and symlink-guarded hive state-dir removal + existence probe.
- `src/service/commands.ts` (M), `stopCommands` per-manager argv (constants only).
- `src/service/index.ts` (M), `stop()`, `isRegistered()`, `ServiceUninstallResult` + `isAlreadyAbsentFailure` classifier, M-1 legacy best-effort split, `describeFailure` detail surfacing.
- `tests/cli-commands.test.ts` (M), stop/uninstall verb suites incl. M-2, gap (c), and W-1 assertions.
- `tests/install/registry.test.ts` (M), delete/contains suites incl. gap (b) fan-out tests.
- `tests/install/state-dir.test.ts` (A), b-AC-4 containment and symlink-refusal tests.
- `tests/service/commands.test.ts` (A), b-AC-1 per-manager stop argv vs uninstall argv contrasts.
- `tests/service/helpers.ts` (M), memory fs gains `fileExists` for the `ServiceFs` extension.
- `tests/service/service-module.test.ts` (M), stop/uninstall/classifier suites incl. gap (a) `isRegistered` tests.
