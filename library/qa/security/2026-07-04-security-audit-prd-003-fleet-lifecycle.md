# Security Audit - PRD-003b fleet lifecycle (hive `stop` + `uninstall`)

> Auditor: `security-worker-bee` (security-stinger) | Date: 2026-07-04
> Target: uncommitted changes on `hive` branch `feature/fleet-lifecycle` (PRD-003b hive scope, W1-V), 10 modified files + 3 untracked, +549/-18
> Ledger: `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md` (superproject)
> Method: full-diff review against the Stinger catalogs (vibe-coding patterns, OWASP 2025, PII/credential) plus deterministic checks (`npm audit`), scoped to the four commissioned focus areas.

## Executive summary

**Verdict: PASS with remediation. No Critical or High findings. One Medium finding fixed in place; one Medium and three Lows documented.**

The diff adds the `stop` verb (service-manager stop with a PID/SIGTERM direct fallback), the three-part `uninstall` verb (stop, service unit removal including the legacy `thehive` names, doctor registry delete across the three candidate paths, contained state-dir removal), `service.isRegistered()`, and AC-named tests. The destructive-filesystem surfaces (state-dir removal, registry rewrite) are well guarded: containment check, symlink refusal, atomic temp-plus-rename writes, and malformed registries are never clobbered. All service-manager invocations are fixed argv over enumerated constants through `execFile` (no shell). Telemetry on uninstall reuses the existing closed allow-list chokepoint and leaks no paths or identifiers.

The one issue worth fixing now (M-1) was an exit-code honesty defect on the destructive flow: the new legacy-unit deregister was composed into the same pass/fail verdict as the current unit, so `hive uninstall` and `hive uninstall-service` would exit 1 with a misleading deregister error on every machine that never had a legacy `thehive` unit (virtually all machines). Fixed in place; gate re-run green.

**Ordering note:** no `quality-worker-bee` report exists for this branch (`library/qa/` was empty in this repo); no ordering inversion. Per the ledger W3 plan, `quality-worker-bee` runs after this audit.

**Scope note:** hive is a Hono daemon on 127.0.0.1:3853, not the Hivemind CLI/MCP stack the Stinger's Deeplake-specific catalogs target. Those categories (Deeplake SQL injection, pre-tool-use gate, captured-trace PII, org scoping) do not exist on this surface and are marked n/a below; universal patterns (secrets, argv injection, destructive fs, telemetry egress, dependency CVEs) were applied at full fidelity. Per the commissioning instructions, the pre-existing CSRF posture on hive POST endpoints is tracked as honeycomb#231 and was not re-litigated; this diff adds no new HTTP endpoints.

## Scorecard (every category checked)

| Category | Result |
|---|---|
| PID validation before `process.kill` | Pass. `readPidFile` (`src/lock.ts:43-52`) requires a parsed integer strictly greater than 0 and returns null otherwise; `isPidAlive` (`src/lock.ts:31-41`) independently re-validates `Number.isInteger(pid) && pid > 0` before the probe. A tampered pid file cannot produce signal 0 broadcasts (pid 0/-1 rejected) or non-numeric input to `kill`. See L-1 for a parse-leniency hygiene note. |
| PID tampering blast radius | Pass. The pid file lives inside the hive state dir created with mode 0o700 (`src/lock.ts:89`); only the owning user can tamper, and that user already holds kill rights over their own processes, so no capability is gained beyond what file permissions allow. Cross-user misdirection is inert: `process.kill` raises EPERM without delivering, the catch prints the error, exit 1 (`src/cli-commands.ts:179-186`). |
| PID-reuse race | L-1 (Low, documented). |
| State-dir removal containment | Pass. `removeHiveStateDir` (`src/install/state-dir.ts:33-48`) checks `isPathWithinRoot(stateDir, fleetRoot)` (resolve + relative, rejects `..` and absolute escapes), refuses when `lstat` reports a symlink, and `rmSync(recursive)` unlinks rather than follows any nested symlink, so a symlink planted inside the state dir cannot delete content outside it. The removed path is always `join(fleetRoot, "hive")` derived from the same resolver, so the containment check is defense-in-depth rather than load-bearing. Env-driven roots (`APIARY_HOME`, `XDG_STATE_HOME`) are honored only when absolute (`src/shared/apiary-root.ts:33-43`), so the root can never anchor on `process.cwd()`. The lstat-then-rm TOCTOU window is same-user-only (0o700 root) and out of the threat model. |
| Registry delete atomicity / malformed input | Pass. `deleteHiveEntryAtPath` (`src/install/registry.ts:171-199`) writes a full serialized document to a unique temp path then `rename`s over the target, removing the temp file if the rename fails; each of the three candidate paths (write path, fleet path, legacy path, deduped via Set) is handled independently, and a missing file (ENOENT) is a clean no-op. A malformed registry (invalid JSON, non-object root, non-array `daemons`) parses to an empty daemon list (`src/install/registry.ts:81-100`), which means no hive entry is found and **no write ever occurs**, so a malformed registry is never clobbered. Sibling entries are preserved byte-for-byte in structure (proven by test `b-AC-3` in `tests/install/registry.test.ts`). See L-2 for one nuance. |
| Service stop/uninstall argv | None detected. `stopCommands`, `uninstallCommands`, and `legacyUninstallCommands` (`src/service/commands.ts:40-76`) interpolate only the enumerated module constants (`SYSTEMD_UNIT_NAME`, `WINDOWS_TASK_NAME`, `LEGACY_*`, `SERVICE_LABEL` via `plan.label`) and the numeric uid from `process.getuid`; `isRegisteredForPlan` (`src/service/index.ts:174-189`) likewise queries only the two enumerated task names. Execution goes through `execFile` (`src/service/index.ts:76`), never a shell; no user-controlled string reaches an argv element. |
| Telemetry on uninstall | None detected. `runUninstallCommand` calls the existing `emitUninstalled` chokepoint (`src/telemetry/emit.ts:533-535`), whose payload is built from the closed allow-list `{package, version, os, arch, node}` (`src/telemetry/emit.ts:143-151`); there is no free-form property path, so the uninstall event cannot carry paths, registry locations, hostnames, or unit names. The registry-path listing printed by the verb goes to local stdout only. `distinct_id` resolution and ledger IO run synchronously at emit initiation, before the state dir is removed, so no state is recreated after removal. Not deduping `hive_uninstalled` is intentional (reinstall cycles). Opt-out gates (`HONEYCOMB_TELEMETRY=0`, `DO_NOT_TRACK`) unchanged. |
| Credentials / token handling / logging | None detected. The diff touches no credential read/write and logs no secret; hive carries no Activeloop token surface. |
| Secrets committed | None detected in the diff. |
| Supply chain / dependencies | None detected. No new dependencies; `npm audit --omit=dev`: 0 vulnerabilities. No dynamic `require`/`eval`/`child_process` additions beyond the existing `execFile` runner. |
| Deeplake SQL injection, pre-tool-use gate, captured-trace PII, org RBAC / scope coercion, prompt injection | n/a on this surface (hive has no Deeplake query layer, no VFS gate, no capture pipeline). |
| CSRF on hive POSTs | Out of scope per commission: pre-existing systemic item tracked in honeycomb#231; this diff adds no HTTP endpoints. |

## Findings

| ID | Severity | Location | Finding | Status |
|---|---|---|---|---|
| M-1 | Medium | `src/service/index.ts:288-291` (pre-fix) | Legacy deregister failure flipped the uninstall verdict: false exit 1 on every no-legacy machine | **FIXED in place** |
| M-2 | Medium | `src/cli-commands.ts:223-227` + `src/service/commands.ts:43,54` | macOS `hive uninstall` still reports failure after a successful stop (double `bootout`) | Documented; recommend nectar-mirrored `alreadyAbsent` classifier |
| L-1 | Low | `src/cli-commands.ts:172-181`, `src/lock.ts:43-52` | PID-reuse race on the SIGTERM fallback; `parseInt` tolerates trailing garbage | Documented |
| L-2 | Low | `src/install/registry.ts:81-100,184` | Registry rewrite silently drops malformed (non-object) sibling entries; non-ENOENT read errors abort the verb before state-dir removal | Documented |
| L-3 | Low | `src/install/registry.ts:228-235` | Unreadable-registry-only installs classified as "nothing to remove" | Documented |

### M-1 (Medium, FIXED) - legacy deregister failures flipped the uninstall verdict to failure

`service.uninstall()` composed `legacyUninstallCommands` and `uninstallCommands` into a single `runAll` whose first failure set `ok: false`. The legacy commands (`launchctl bootout .../thehive`, `systemctl --user disable --now thehive.service`, `schtasks /Delete /TN thehive /F`) are **expected to fail** whenever no pre-decision-#32 unit exists, which is the common case on every current machine. Consequence: `hive uninstall` and `hive uninstall-service` exited 1 and printed "a deregister command reported an error" on all three platforms even when every real step succeeded, violating the documented best-effort legacy contract (`src/service/commands.ts:62-66`, PRD-003b b-AC-2 "best-effort legacy label") and AC-9's clear-outcome requirement. Security relevance: a destructive flow that habitually reports false failure trains operators and scripts to ignore its exit code, which then masks the genuine boot-resurrecting-unit failure class (the exact defect nectar's W2 verifier reopened as b-AC-2). The unit-test suite could not catch it because the recording runner succeeds on every command.

**Remediation applied** (`src/service/index.ts`): the legacy commands now run in their own best-effort `runAll` whose result is deliberately ignored (matching `install()`'s existing posture), and only the current-unit commands gate `ok`. Command order is unchanged, so the exact-argv test contracts (`b-AC-2 uninstall deregisters legacy and current units`) still hold. Gate re-run: typecheck exit 0, 472/472 tests pass.

### M-2 (Medium, documented) - macOS `hive uninstall` residual false failure from double `bootout`

On launchd both `stopCommands` and `uninstallCommands` are `launchctl bootout` of the current label (`src/service/commands.ts:43,54`); `bootout` unloads the service, it is not a plain stop. The `uninstall` verb runs the stop step first (`src/cli-commands.ts:223`), so by the time `service.uninstall()` issues its own `bootout` the unit is already gone and launchctl fails with "No such process" (exit 3), making macOS `hive uninstall` exit 1 despite full success even after the M-1 fix (Linux `systemctl disable --now` and Windows `schtasks /Delete /F` both succeed on a stopped unit, so only launchd is affected). Not remediated here: the correct fix is an already-absent result classifier on the current-unit deregister (nectar shipped exactly this in W2-Nfix: launchd exit 3, sc 1060, locale-independent not-found text), which is a design-plus-tests change beyond a minimal security patch. Recommend the hive implementation worker mirror nectar's `ServiceUninstallResult`/`alreadyAbsent` pattern before ship; without it, macOS b-AC-6/AC-9 behavior is wrong in the common path.

### L-1 (Low, documented) - PID-reuse race on the SIGTERM fallback; lenient parse

When the service is not registered, `runStopCommand` reads `<stateDir>/hive.pid` and sends SIGTERM (`src/cli-commands.ts:172-181`). If the daemon crashed without cleanup and the OS recycled the PID to another process owned by the same user, the signal hits an innocent process. Assessment: cross-user harm is impossible (EPERM raised, caught, exit 1, no delivery); same-user harm requires a stale file in the user's own 0o700 state dir and grants no capability the user does not already have, so this stays Low per the commissioned threat model ("beyond what file permissions already allow"). The window is also narrowed by `releaseSingleInstanceLock` removing the pid file on graceful shutdown. Hygiene note: `readPidFile` uses `Number.parseInt(raw, 10)`, so `"123abc"` parses as 123; a strict `^\d+$` match would be tighter. No identity re-verification (start-time/cmdline comparison) is proposed: it is platform-specific and itself racy. Optional hardening if ever desired: signal only when the lock file agrees (`isLockHeldByLiveDaemon`).

### L-2 (Low, documented) - registry rewrite drops malformed sibling entries; non-ENOENT read errors abort the verb early

`parseRegistryDocument` filters non-object members out of `daemons` (`src/install/registry.ts:93-97`), and `deleteHiveEntryAtPath` serializes that filtered list back (`:184-186`), so a corrupted sibling entry (for example a bare string where another product's object should be) is silently dropped by hive's delete. Impact is minimal (doctor ignores malformed entries and each product can re-register), and the pattern is shared with the pre-existing `registerHiveWithDoctor` upsert. Separately, a non-ENOENT read error (EACCES, EISDIR) on any candidate path propagates out of `deleteHiveFromDoctor` and aborts `runUninstallCommand` before the state-dir step; `cli.ts:52-56` catches it and prints the message with exit 1 (no stack trace), but the friendlier per-step handling the state-dir step has (`src/cli-commands.ts:237-245`) does not cover the registry step. Cosmetic/resilience only.

### L-3 (Low, documented) - unreadable registry can misclassify an install as "nothing to remove"

`registryContainsHiveEntry` swallows all read errors as "absent" (`src/install/registry.ts:228-235`). If the only remaining artifact of an install is a registry entry inside a file that exists but cannot be read, `hive uninstall` exits 0 claiming nothing to remove while doctor keeps probing hive. Requires an unusual permission state on a file inside the user's own fleet root; acceptable for no-op detection, noted for completeness.

## Remediation performed

| File | Change |
|---|---|
| `src/service/index.ts` | M-1: split `uninstall()`'s single `runAll` into a best-effort legacy pass (result ignored, mirroring `install()`) followed by the current-unit pass that alone gates `ok`. 5 lines changed plus a 3-line intent comment; no other behavior touched. |

Post-remediation verification: `git diff` inspected, only the M-1 lines changed beyond the audited PRD-003b work; `npx tsc --noEmit` exit 0; `npx vitest run` 64 files, 472/472 passed (the 4 machine-local flaky tenancy suites documented in the ledger all passed this run). Nothing committed, per commission.

## Files reviewed

`src/cli-commands.ts` (stop/uninstall verbs) | `src/cli.ts` (dispatch) | `src/install/registry.ts` (delete + contains) | `src/install/state-dir.ts` (new, containment + symlink refusal) | `src/service/commands.ts` (stop/legacy argv) | `src/service/index.ts` (stop, isRegistered, uninstall composition) | `src/lock.ts` (readPidFile/isPidAlive, unchanged but load-bearing) | `src/shared/apiary-root.ts`, `src/shared/registry-paths.ts`, `src/shared/legacy-paths.ts` (path resolution, unchanged) | `src/telemetry/emit.ts` (chokepoint, unchanged) | tests: `tests/cli-commands.test.ts`, `tests/install/registry.test.ts`, `tests/install/state-dir.test.ts` (new), `tests/service/commands.test.ts` (new), `tests/service/service-module.test.ts`, `tests/service/helpers.ts` | `README.md`.

## Handoffs

- M-2 to the hive implementation worker (W1-V) or the ship loop: mirror nectar's `alreadyAbsent` deregister classifier before tag.
- `quality-worker-bee` runs next per ledger W3; this report predates any QA report for the branch, so ordering is clean.
