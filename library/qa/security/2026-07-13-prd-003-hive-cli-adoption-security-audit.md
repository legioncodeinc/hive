# Security Audit Report: PRD-003 Hive CLI Adoption

**Audit date:** 2026-07-13
**Auditor:** security-worker-bee
**Scope:** All uncommitted PRD-003 adoption files, with focused review of CLI dispatch, lifecycle/uninstall, service adapters/templates/wrapper, updater, registry, status/logs/telemetry, shared paths, tests, package metadata, and migration documentation
**Node requirement:** >=22
**`npm audit` result:** 0 vulnerabilities
**OpenClaw bundle scan:** Not applicable; Hive ships no OpenClaw bundle/audit script
**CVE catalog:** Security Stinger catalog refreshed 2026-04-25 (current)

## Executive Summary

Scope note: Hive's native service managers, local registry, dashboard daemon, and npm updater are outside the Stinger's Hivemind-specific Deep Lake catalog; universal command execution, filesystem, credential, terminal, network-bound, and supply-chain controls were applied. Three High findings were fixed: service logs could follow a planted symlink, existing logs and registry replacement files could retain permissive modes, and untrusted service/environment text could inject terminal control sequences. Follow-up reviews removed launchd/systemd's direct log opening and closed the prior Medium registry finding with owner-aware locking plus fail-closed malformed-document handling. A quality report was produced before this final security re-review and is stale; quality must rerun after these changes. The PRD-003 security gate is **PASS**.

## Scorecard

| Category | Status | Findings |
|---|---|---:|
| Credential / telemetry secrecy | OK | 0 |
| Uninstall confirmation / path ownership | OK | 0 |
| Command / argv construction and npm version validation | OK | 0 |
| Service wrapper signals and log permissions | FAIL (fixed) | 2 High |
| Registry product isolation | OK | 1 Medium closed |
| Log binding / redaction / symlinks | FAIL (fixed) | 1 High |
| Terminal and JSON integrity | FAIL (fixed) | 1 High (shared with log/output findings) |
| Health/network bounds | OK | 0 |
| Dependencies / supply chain | OK | 0 |

## Critical Findings

None detected.

## High Findings (fixed)

- [x] **Symlink log clobber** `src/service/daemon-wrapper.ts:12-27,37-47`, `src/service/templates.ts:42-98` - The wrapper opened the fixed service log with append semantics before checking file identity, and launchd/systemd could bypass the wrapper by opening the same path themselves. `openOwnedLog` now rejects symlinks, uses `O_NOFOLLOW` where supported, requires a regular file, and fails before spawning; every service definition invokes the fixed `service-daemon` action and contains no native stdout/stderr path directive.
- [x] **Sensitive local file permissions** `src/service/daemon-wrapper.ts:18-25`, `src/install/registry.ts:62-68` - Creation mode alone does not repair pre-existing permissive files and registry temp files relied on umask. Service logs and registry replacement files now receive explicit `0600` enforcement (Windows continues to rely on the user's inherited ACL model).
- [x] **Terminal escape injection** `src/terminal-safety.ts:1-6`, `src/cli-interface.ts:117-122` - Service-manager errors, environment-derived paths, and injected command output could carry ANSI/OSC/control sequences to the human terminal. The CLI's human stdout/stderr boundary now strips terminal controls; JSON output remains untouched and safely escaped by `JSON.stringify`.

## Medium Findings (fixed)

- [x] **Registry lost-update / corrupt-document recovery** `src/install/registry.ts:84-159,197-278` - The earlier implementation could overwrite concurrent peer updates and treated malformed JSON as an empty registry. The complete read-validate-modify-temp-rename transaction now runs under a bounded, private owner-token lock; stale recovery requires both age and a dead/invalid recorded PID, release verifies the owner token, malformed documents fail without mutation, and exclusive randomized temp files prevent pre-planted symlink clobbering.

## Low Findings

None detected.

## Boundary Review Evidence

- `uninstall` requires interactive confirmation, and JSON uninstall requires explicit `--yes` (`src/cli-interface.ts:156-183`). State removal resolves only `<fleetRoot>/hive`, checks containment, and rejects a symlinked state directory (`src/install/state-dir.ts:33-49`). Registry deletion filters only entries whose name is exactly `hive`.
- Service-manager and updater execution use fixed executable/argv arrays through `execFile` with no shell (`src/service/index.ts:104-124`, `src/cli-update.ts:19-24`). Manager commands use constant unit/task identifiers. Windows XML, launchd plist, and systemd values are escaped/quoted before rendering.
- npm's approved target is accepted only when it matches the bounded version grammar, and it is passed as one fixed package-spec argv element (`src/cli-update.ts:9,28-40,63-79`). The updater has a 120-second process timeout, stops/restarts only an installed service, rolls back to the installed package version after failed health, and verifies recovery.
- Log reads are hard-bound to product `hive`, service `com.legioncode.hive`, and Hive's owned state root. cli-kit performs canonical `realpath` containment, option/content limits, secret redaction, and terminal-control removal; Hive exposes no arbitrary path/product selector (`src/cli-observability.ts:119-153`).
- SIGINT/SIGTERM handlers are removed on child completion, signals are forwarded without shell mediation, descriptors are closed once, and spawn errors fail closed (`src/service/daemon-wrapper.ts:49-82`).
- AC-b9 remains truthfully satisfied through a fixed indirection: launchd `ProgramArguments`, systemd `ExecStart`, and the Windows task action pin Node, Hive's installed CLI entrypoint, and the literal `service-daemon` command. That internal command alone resolves Hive's authoritative log destination from the pinned Apiary home and opens it through the no-follow/private-mode boundary. Template tests prove all three fixed actions and prove launchd/systemd contain no bypassing native log directives (`src/service/templates.ts:42-98,139-163`, `tests/service/templates.test.ts`).
- Human output is sanitized at the dispatch boundary. JSON uses a single `JSON.stringify` envelope and never mixes stderr/banner/credit into stdout. Log JSON is automatically bounded (`--no-follow`) and contains redacted lines.
- Non-streaming human commands buffer their bounded result and route success to stdout or operational failure to stderr. Confirmation, status, telemetry, logs, and handler exceptions are converted into one JSON envelope with empty stderr in JSON mode (`src/cli-interface.ts:117-270`).
- The packed conformance script uses `spawnSync` with fixed argv, `shell: false`, a 180-second timeout, a 2 MiB output cap, a basename-confined tarball path, and unconditional temp/tarball cleanup. CI runs it under read-only repository permissions after `npm ci`, tests, and build (`scripts/verify-packed-cli.mjs`, `.github/workflows/ci.yaml:89-90`).
- Telemetry summary reveals only opt-out state, controlling setting, destination class, and timestamps; the configured PostHog key is tested only for presence and is never returned (`src/cli-observability.ts:85-111`).
- Status and update health requests use one-second abort signals. Retry count is capped at 60 and retry delay at five seconds (`src/cli-observability.ts:42-62`, `src/cli-commands.ts:150-169`).
- `npm audit --audit-level=high` reports zero vulnerabilities. No committed `.env` file or hidden Unicode in recognized agent-rule files was detected.

## Verification

| Gate | Result |
|---|---|
| Focused PRD-003/security tests | PASS - 11 files, 106 tests |
| Follow-up service-definition security tests | PASS - 5 files, 55 tests |
| Final registry/output/packed security tests | PASS - 5 files, 55 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm audit --audit-level=high` | PASS - 0 vulnerabilities |
| `git diff --check` | PASS |
| Full `npm test` (final security run) | 821/822 passed; one unrelated onboarding gate test hit its five-second timeout |
| `npm run test:packed-cli` | PASS - packed install and CLI conformance, with bounded fixed-argv subprocesses and cleanup |

The single full-suite timeout did not touch the PRD-003 files or security remediations; focused and packed suites are deterministic and green. Quality must rerun after this final security pass because its existing report predates the owner-aware lock changes.

## Files Changed by Security Review

| File | Change |
|---|---|
| `src/terminal-safety.ts` | Added terminal control-sequence sanitizer. |
| `src/cli-interface.ts` | Sanitized all human output at the CLI boundary while preserving JSON. |
| `src/cli-commands.ts` | Hard-capped health retry count and delay. |
| `src/service/daemon-wrapper.ts` | Added no-follow regular-file log opening, explicit modes, and safe shared descriptor cleanup. |
| `src/install/registry.ts` | Added private owner-aware locking, dead-owner stale recovery, fail-closed parsing, and exclusive randomized temp files. |
| `tests/cli-interface.test.ts` | Added OSC injection regression coverage. |
| `tests/service/daemon-wrapper.test.ts` | Added permission repair and symlink rejection coverage. |
| `tests/install/registry.test.ts` | Added POSIX registry-mode coverage. |
| `scripts/verify-packed-cli.mjs` | Bounded fixed-argv subprocess time/output and retained unconditional cleanup. |
| `library/knowledge/private/operations/cli-and-runbook.md` | Corrected lock-holder and stale-recovery claims. |

## Security Gate Verdict

**PASS.** No Critical, High, or Medium security finding remains open in the Hive PRD-003 adoption. The final dogfood addendum below records and closes the lifecycle-convergence follow-ups. Quality must include this addendum in its rerun.

## Dogfood Lifecycle Convergence Addendum - 2026-07-13

### Scope and verdict

Reviewed only the live-Windows-dogfood orphan convergence delta in `src/cli-commands.ts`, Unix service reconciliation in `src/service/index.ts`, and their focused tests. Termination polling is bounded, restart/install do not continue after a nonzero stop result, and restart never starts a replacement while the prior PID remains live. Both same-user Medium follow-ups are closed: process identity is revalidated after service-manager stop immediately before signaling, and existing symlinked service-unit targets are refused. No Critical, High, or Medium regression remains. Verdict: **PASS**.

### Medium findings

- [x] **PID reuse / identity ambiguity** `src/cli-commands.ts:240-300`, `src/process-identity.ts:10-70` - Every live PID is now checked immediately before `SIGTERM`, including a second post-`service.stop()` check in the registered-service path. A cached pre-stop PID must still equal the reread PID, and the live process must independently pass the identity check. Linux reads NUL-delimited `/proc/<pid>/cmdline`; Windows uses fixed-argv, non-shell PowerShell/CIM with a 10-second timeout; macOS uses fixed-argv `ps` with the same bound. All paths require an exact normalized CLI-entry argument immediately followed by `daemon`, and lookup/parse/command failures fail closed. Regression coverage rejects separated tokens and proves post-manager identity revalidation prevents signaling.
- [x] **Existing Unix unit symlink rewrite** `src/service/index.ts:141-157,381-388` - `install()` first refuses an existing `lstat`-identified symlink, and the production writer then opens the fixed unit path with `O_NOFOLLOW` where supported, verifies the opened descriptor is a regular file with `fstat`, and only then truncates/writes it. This closes both the existing-target clobber and the Unix check/write symlink race before any service-manager install command. `tests/service/service-module.test.ts` covers refusal and proves the manager is not invoked.

### Race and bound analysis

- `stopAttempts` is clamped to 1-100 and `stopDelayMs` to 0-1000 ms; defaults are 40 attempts and 50 ms. No unbounded wait or busy retry was introduced.
- PID state is reread before signaling. If it is absent/dead, stop converges without a signal. If `SIGTERM` throws or the PID remains alive, stop returns `1`.
- A service-manager failure returns `1` while the daemon is live. A manager-reported failure with no live Hive PID is treated as an already-stopped idempotent result.
- `restart` calls the shared stop transaction and returns before `service.start()` on any termination failure. Health verification remains separately capped and request-aborted.
- `install` and `service-install` stop an existing registered service before rewriting/re-enabling its definition. Removing the Unix early return ensures stale `start` actions are replaced by the fixed `service-daemon` action; manager execution remains fixed argv without a shell.

### Addendum verification

| Gate | Result |
|---|---|
| Lifecycle/service focused tests | PASS - initial pass: 3 files, 51 tests |
| Added stuck-orphan bound test | PASS - one SIGTERM, exact configured polls/delays, exit 1 |
| Added restart fail-closed test | PASS - replacement start not called while prior PID remains alive |
| `npm run typecheck` | PASS |
| `git diff --check` | PASS |

No production code was changed by this dogfood security re-review; only focused regression tests and this report addendum were added.

### Final closure re-review - 2026-07-13

- Focused identity, lifecycle, service-module, and template suites pass: 4 files, 68 tests.
- `npm run typecheck` and `git diff --check` pass.
- Live Windows evidence supplied by the implementation pass confirms both immediate identity checks during restart convergence from PID 110864 to healthy Hive 0.11.1 PID 116892.
- Both dogfood Mediums are closed. Final security verdict: **PASS** with no open Critical, High, or Medium finding.
