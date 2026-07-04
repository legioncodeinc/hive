# QA Report: PRD-010 Apiary state root migration (hive slice)

**Plan document:** `hive/library/requirements/backlog/prd-010-apiary-state-root-migration/` (index + 010a + 010b + 010c), grounded in `hive/library/knowledge/private/architecture/ADR-0005-fleet-directory-ownership-and-neutral-state-root.md` (Resolved decisions + the 2026-07-04 absolute-only amendment)
**Audit date:** 2026-07-04
**Base branch:** `main` (audit target is the uncommitted working tree)
**Head:** `feature/apiary-root-and-nectar-activation` (HEAD `de1350c`, all changes uncommitted)
**Auditor:** quality-worker-bee

Ordering check: `security-worker-bee` ran first for this branch (report at `hive/library/qa/security/2026-07-04-security-audit.md`) and remediated three Medium/Low findings in place (lock-dir and registry mkdir 0o700 parity, relative-XDG rejection). An orchestrator alignment then replaced the relative-`APIARY_HOME` resolve-against-home semantics with the fleet absolute-only rule (`src/shared/apiary-root.ts` plus the updated rr-AC-3 test), and the ADR mirror carries the matching amendment. Those changes are part of the implementation under review here. Correct order; no violation.

## Summary

Pass with warnings. All 30 acceptance criteria across 010a/b/c are implemented, the updated rr-AC-3 absolute-only semantics match the amended ADR chain exactly, boot ordering (migrate, then lock+pid, then registry upsert) is pinned in `startHive`, and both gates are green (`npm run typecheck` clean, `npm test` 384/384 passed, 56 files). No Critical findings. Five Warnings: the `APIARY_HOME`/`--home=` install pinning surface described in 010a is absent (units rendered under an override embed override log paths that the manager-started daemon will not resolve at runtime), the legacy pid/lock cleanup claimed as best-effort can throw, the read fallback triggers on any read error rather than absence only (diverging from mg-AC-10's letter on an edge), and two AC-named test-coverage gaps (registry-preservation assertions; ordering assertion). Recommend fixing or explicitly descoping the Warnings before the branch is declared shippable; none blocks merge on its own.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅     | Every rr/mg/rc AC and index module AC traced to code; no absent requirement |
| Correctness   | ⚠️     | Three behavioral edges diverge from the plan letter (W-1 unit env pinning, W-2 non-best-effort legacy cleanup, W-3 fallback-on-any-error) |
| Alignment     | ✅     | Mirror-not-import helper in `src/shared/`, legacy constants quarantined in one module with the removal criterion, non-goals honored |
| Gaps          | ⚠️     | AC-named test gaps: rc-AC-1 preservation and rc-AC-2 ordering are asserted weakly; rr-AC-5/rr-AC-6 have no named tests (W-4, W-5) |
| Detrimental   | ✅     | No regressions: typecheck clean, 384/384 tests green, no cwd reads, no `~/.deeplake` touches, no new dependencies |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **APIARY_HOME override is not pinned into rendered service units, and the `hive install --home=` surface does not exist**, `src/service/templates.ts:25-27`, `src/service/platform.ts:35-41`, `src/cli.ts:12`

  010a's implementation notes state the runtime daemon and a rendered unit agree "because the installer also writes `APIARY_HOME` into the unit's environment block when a non-default root is chosen", and rr-AC-10's second clause requires the enterprise opt-in path to pin the installing user's resolved root. Neither exists: the launchd plist has no `EnvironmentVariables` block, the systemd unit has no `Environment=` line, the task XML sets no environment, and the CLI accepts no `--home=` (grep for `--home` and `APIARY_HOME` outside `apiary-root.ts` returns nothing). Consequence: `APIARY_HOME=/custom hive install` renders log paths under `/custom/hive/` (render-time env is honored), but the daemon later started by launchd/systemd/schtasks does not inherit `APIARY_HOME`, so its state resolves to `~/.apiary/hive/` while the unit's log paths point at the override root. Default installs (no override) are unaffected, and hive's Windows service is per-user `InteractiveToken` only (no LocalSystem opt-in exists in this repo), which shrinks the blast radius; but the override scenario the PRD describes is incoherent as shipped. Fix by pinning `APIARY_HOME` into each rendered unit when the resolved root differs from the default, or record an explicit descope of the override-install scenario against the index open question ("`--home=` surface on hive, DEFAULT - confirm before implementation").

  ```typescript
  // templates.ts:25 - honored at RENDER time only; nothing pins it into the unit:
  const logs = resolveLaunchdLogPaths({ home: plan.home, env: process.env });
  ```

- [ ] **`removeStaleLegacyLockArtifacts` is not best-effort**, `src/lock.ts:63-66,108`

  mg-AC-6 says the boot "best-effort removes the stale legacy `hive.pid`/`hive.lock` files". The implementation calls `rmSync(..., { force: true })` unguarded inside `acquireSingleInstanceLock` after the new lock is held. `force: true` suppresses only ENOENT; an EBUSY/EPERM (a file held open on Windows, a permissions oddity in the legacy dir) throws out of `acquireSingleInstanceLock` and aborts the boot with the new lock file left on disk. Wrap the two `rmSync` calls in a try/catch so a cleanup failure can never block the always-on portal's boot.

  ```typescript
  function removeStaleLegacyLockArtifacts(deps: FleetRootDeps = {}): void {
    rmSync(resolveLegacyHiveLockPath(deps), { force: true });
    rmSync(resolveLegacyHivePidPath(deps), { force: true });
  }
  ```

- [ ] **Read fallbacks trigger on any read error, not absence only**, `src/shared/registry-paths.ts:40-49`, `src/daemon/installer/token.ts:40-56`

  mg-AC-10 pins the fallback contract: "when the new path exists, the legacy path is not consulted for that read (new wins; fallback is absence-triggered only)". `readRegistryBody` consults the legacy registry whenever `readFileSync` on the new path throws for any reason, including EACCES on a present-but-unreadable file, and the token read behaves the same way (any `readTextFile` failure reads the legacy token). In that degenerate state the code silently serves stale legacy data where the AC says the new file wins. Low likelihood, but it is a letter-of-the-plan divergence on the exact contract the ADR window depends on. Distinguish ENOENT from other errors (fall back only on ENOENT; treat other errors as a present-but-unreadable new file, yielding defaults).

  ```typescript
  try {
    return readFile(newPath);
  } catch {
    // Legacy-window read fallback; removal criterion in legacy-paths.ts.
    try {
      return readFile(resolveLegacyDoctorRegistryPath(options));
  ```

- [ ] **rc-AC-1's preservation guarantees are implemented but not asserted**, `tests/install/registry.test.ts:37-73`, `src/install/registry.ts:127-149`

  rc-AC-1 requires the upsert to preserve "all other products' entries and any unknown root keys". The code does both (`{ ...parsed.root, daemons: nextDaemons }` plus per-entry spread), but no test asserts it: the d-AC-7 fixture includes a honeycomb entry, yet the assertions filter for `hive` only and never check that the honeycomb entry or an unknown root key survives the write. Add an rc-AC-1-named test seeding a foreign entry plus an unknown root key and asserting both are byte-preserved after `registerHiveWithDoctor`.

- [ ] **rc-AC-2/mg-AC-7 boot ordering is correct in code but the test asserts only an invocation count**, `src/daemon/server.ts:198-209`, `tests/daemon/server.test.ts:149-163`

  The ordering (migrate, then `acquireSingleInstanceLock` writing the new pid, then `registerWithDoctor` in the same boot) is pinned by the statement order in `startHive` and is correct. The only test touching it (`a-AC-7`, with an rc-AC-2 comment) asserts `registered === 1` and cannot fail if the ordering regresses (e.g. register moved before the lock). Record a sequence (push labels from the `migrateState`, `registerWithDoctor`, and `serveFn` seams plus a lock-file existence probe) and assert the order, named `rc-AC-2`.

## Suggestions (consider improving)

- [ ] **Global brooding-independent note: disable panel controls before first hydration**, `src/dashboard/web/pages/hive-graph.tsx` (NectarProjectsPanel `controlsDisabled`)

  Covered in the companion PRD-019c report; listed here only because the file rides this branch.

- [ ] **`DOCTOR_REGISTRY_PATH` (write side) is a module-load snapshot of a window-dependent value**, `src/install/registry.ts:7`

  `resolveRegistryWritePath()` answers differently before and after the fleet root exists; freezing it into an exported constant at import time invites a future caller to use a stale answer. `registerHiveWithDoctor` correctly re-resolves per call, so behavior today is right; consider exporting a function (or documenting the constant as informational only).

- [ ] **Add AC-named tests for rr-AC-5 and rr-AC-6**, `tests/shared/apiary-root.test.ts`, `tests/telemetry/emit.test.ts`

  Both behaviors are implemented and indirectly covered (rr-AC-4 resolver assertions; `a-AC-4` lock-file writes; the 0o700 ledger path), but the repo convention names each test after the AC it proves and neither AC appears in a test name. Cheap to add against the existing seams.

## Plan Item Traceability

### PRD-010a (rr-AC-1..11)

| #        | Plan Requirement | Status | Implementation Location | Notes |
|----------|------------------|--------|--------------------------|-------|
| rr-AC-1  | Default root `<home>/.apiary`; Linux XDG only when explicitly set; no `~/.local/state` default; purely environmental | ✅ | `src/shared/apiary-root.ts:23-46` | Tests: four `rr-AC-1` cases incl. relative-XDG rejection and production `os.homedir()` default |
| rr-AC-2  | Absolute `APIARY_HOME` wins over everything | ✅ | `src/shared/apiary-root.ts:33-36` | Test `rr-AC-2` |
| rr-AC-3  | UPDATED semantics: no `process.cwd()` anywhere; a relative `APIARY_HOME` is rejected (chain falls through), per the ADR absolute-only amendment | ✅ | `src/shared/apiary-root.ts:28-36` | Test `rr-AC-3` asserts relative value ignored. Independent grep: zero `process.cwd()` reads in `src/` (only comments). `win32.isAbsolute` superset check matches the amendment text |
| rr-AC-4  | Chain semantics match the ADR byte-for-byte so mirrored helpers agree | ✅ | `src/shared/apiary-root.ts:18-46` | Test `rr-AC-4` covers hive derivations; cross-product byte parity is verifiable only against sibling repos (out of this repo's test reach) |
| rr-AC-5  | pid/lock default to `~/.apiary/hive/hive.pid|.lock`, recursive mkdir preserved | ✅ | `src/shared/constants.ts:19-20`, `src/lock.ts:24-29,75` | No `rr-AC-5`-named test (see Suggestion); covered via `rr-AC-4` + `a-AC-4` |
| rr-AC-6  | `HIVE_STATE_DIR` = `~/.apiary/hive/` (0o700), token + onboarding ledger follow | ✅ | `src/telemetry/emit.ts:95-101,258,303`, `src/daemon/installer/config.ts:30`, `src/telemetry/onboarding-session-ledger.ts:98` | No `rr-AC-6`-named test (see Suggestion) |
| rr-AC-7  | Only remaining `.honeycomb` literals are legacy-window code with removal-criterion comments | ✅ | `src/shared/legacy-paths.ts:6-12,20` | Verified with independent grep: the ONLY path literal `".honeycomb"` in `src/` is `legacy-paths.ts:20`, under the module header carrying the ADR removal criterion; every fallback site imports from that module and comments the window (`registry-paths.ts:43`, `config.ts:50`, `emit.ts:269`, `token.ts:5-6`) |
| rr-AC-8  | Registry entry names the new pid location in doctor's pinned convention | ✅ | `src/shared/apiary-root.ts:87-90`, `src/install/registry.ts:11,102` | Convention resolved by ADR Resolved decision 4 (resolved absolute paths, never tilde); test `d-AC-6` asserts `pidPath === resolveHiveRegistryPidPath()` |
| rr-AC-9  | Launchd plist renders `<root>/hive/launchd.{out,err}.log` reflecting the resolved root | ✅ | `src/service/templates.ts:25-27` | Test `rr-AC-9`. Render-time env honored; the runtime-side coherence for overrides is W-1 |
| rr-AC-10 | Windows XML stages to `<root>/hive/hive-task.xml`; LocalSystem opt-in pins the installing user's root | ⚠️ | `src/service/index.ts:108-110`, `src/shared/apiary-root.ts:75-77` | First clause ✅ (test `rr-AC-10`). Second clause: hive has no LocalSystem opt-in (per-user `InteractiveToken` only, `templates.ts:91-92`), so the edge is structurally N/A, but no pinning mechanism exists at all (W-1) |
| rr-AC-11 | Pre-PRD units keep working without re-install; next `hive install` adopts new paths | ✅ | `src/service/templates.ts:34-39` (ProgramArguments carry no state paths), `src/service/index.ts:172-197` | By analysis: unit paths affect only log destinations/staging. No test (behavioral claim) |

### PRD-010b (mg-AC-1..10)

| #        | Plan Requirement | Status | Implementation Location | Notes |
|----------|------------------|--------|--------------------------|-------|
| mg-AC-1  | First boot migrates state-dir contents byte-identically | ✅ | `src/shared/state-migration.ts:14-20,63-105` | Test `mg-AC-1`. Set covers `install-id`, `telemetry.json`, `onboarding-telemetry.json` (the session ledger), `hive-task.xml`, `onboarding-token`; launchd logs deliberately excluded per 010b notes |
| mg-AC-2  | Idempotent; new-path files never overwritten | ✅ | `src/shared/state-migration.ts:48` (skip-if-exists) | Test `mg-AC-2` |
| mg-AC-3  | Copy failure leaves legacy untouched; daemon still boots; retry next boot | ✅ | `src/shared/state-migration.ts:32-38,50-56` (copy-verify, rm dest on verify failure, source retained) | Test `mg-AC-3`. `migrateHiveState` never throws by construction, so boot cannot block |
| mg-AC-4  | Fresh machine: single legacy existence check; new dir 0o700 | ✅ | `src/shared/state-migration.ts:70-78` | Test `mg-AC-4`. The lock path adds one legacy-lock existence probe per boot, required by mg-AC-5; consistent with the ACs read together |
| mg-AC-5  | Live legacy lock blocks a double-start | ✅ | `src/lock.ts:54-61,69` | Test `mg-AC-5` |
| mg-AC-6  | Clean upgrade: new lock+pid, best-effort stale legacy removal | ⚠️ | `src/lock.ts:63-66,108` | Test `mg-AC-6` passes, but the removal is not best-effort (W-2) |
| mg-AC-7  | Registry entry and live pid file never disagree long enough to restart-loop | ✅ | `src/daemon/server.ts:198-209` | Ordering correct in code; test asserts count only (W-5) |
| mg-AC-8  | distinct_id order: fleet install-id, legacy install-id, own id, fresh UUID | ✅ | `src/telemetry/emit.ts:275-309` | Test `mg-AC-8` covers fleet-first and legacy fallback |
| mg-AC-9  | Token dual read, 0600 + constant-time preserved; invalidation deletes the serving path | ✅ | `src/daemon/installer/token.ts:47-56,76-83`, `src/daemon/installer/config.ts:50-51,110` | Test `mg-AC-9`. Divergence in the safe direction: `invalidate()` deletes BOTH paths, a superset of "whichever path served it"; endorsed by the security audit (F-6) so no resurrectable legacy token can remain |
| mg-AC-10 | New path wins; fallback is absence-triggered only | ⚠️ | `src/shared/registry-paths.ts:39-49`, `src/daemon/installer/token.ts:48-53` | Tests `mg-AC-10`/`rc-AC-4` cover the normal case; any-read-error (not absence-only) triggers fallback on the EACCES edge (W-3) |

### PRD-010c (rc-AC-1..9)

| #        | Plan Requirement | Status | Implementation Location | Notes |
|----------|------------------|--------|--------------------------|-------|
| rc-AC-1  | Upsert into `~/.apiary/registry.json`, atomic temp+rename, preserves other entries + unknown root keys, new pidPath | ✅ | `src/install/registry.ts:124-155` | Behavior correct; preservation not asserted by any test (W-4). Atomicity asserted by `d-AC-8` |
| rc-AC-2  | Same-boot ordering: lock + new pid first, then registry upsert; no never-existed pidPath window | ✅ | `src/daemon/server.ts:200-209` | Ordering correct; register is fail-soft (try/catch) so a mid-move registry cannot block boot. Test asserts count only (W-5) |
| rc-AC-3  | Write new when fleet root dir exists, else legacy; never both | ✅ | `src/shared/registry-paths.ts:10-16` | Tests: two `rc-AC-3` cases. Note: on hive's own boot/install, `migrateHiveState` creates `<root>/hive` (and thus the root) before registration, so hive's legacy-write branch is exercised only by callers that register before migration; this conforms to the ADR contract as written (root-existence marker, deterministic) |
| rc-AC-4  | New path present: legacy not consulted | ✅ | `src/shared/registry-paths.ts:39-42` | Test `rc-AC-4`; EACCES edge under W-3 |
| rc-AC-5  | New absent: legacy read produces today's result | ✅ | `src/shared/registry-paths.ts:43-48` | Test `rc-AC-5` |
| rc-AC-6  | Neither/corrupt: loopback defaults for bases, empty names, never a throw | ✅ | `src/daemon/registry.ts:47-57,78-98,112-126` | Test `rc-AC-6` plus pre-existing corrupt-registry tests unchanged |
| rc-AC-7  | Mid-migration honesty: closed health set, gate terminates on `/buzzing`, no 500s, no fake green | ✅ | `src/daemon/fleet-status.ts`, `src/daemon/gate.ts` (untouched), readers now on the fallback chain | Posture deliberately unchanged; pre-existing gate/fleet-status tests plus the updated shell-connectivity-gate suite cover it |
| rc-AC-8  | Proxy + setup-auth ride the fallback chain, degrade to defaults | ✅ | `src/daemon/proxy.ts` and `src/daemon/setup-auth.ts:53` via `resolveDaemonBases` -> `readRegistryBody` | Server test `c-AC-1` exercises the proxied resolution path |
| rc-AC-9  | Portal back within the manager restart interval; migration never extends the outage | ✅ | `src/service/templates.ts:42-45,66-67,105-108` (KeepAlive / Restart=always / RestartOnFailure unchanged), `src/shared/state-migration.ts` (never throws) | Tests `d-AC-2/d-AC-3` unchanged and green |

### Index module ACs and non-goals

| #      | Plan Requirement | Status | Implementation Location | Notes |
|--------|------------------|--------|--------------------------|-------|
| IDX-1  | One root helper, exact ADR precedence, never cwd, every inventory constant through it | ✅ | `src/shared/apiary-root.ts` (all ten inventory rows re-derived) | `--home=` never enters the helper (delivered as `APIARY_HOME` per the ADR); the install-side `--home=` surface itself is absent (W-1) |
| IDX-2  | One-time idempotent migration on first boot | ✅ | `src/daemon/server.ts:191-198`, `src/service/index.ts:150-154,172-173` (install converges too) | |
| IDX-3  | Never delete an unmigrated legacy file | ✅ | `src/shared/state-migration.ts:50-56` | rm of source only after verified copy |
| IDX-4  | Single-instance across the upgrade boot; watchdog-consistent pidPath | ✅ | `src/lock.ts:54-69`, `src/daemon/server.ts:200-209` | |
| IDX-5  | `resolveDistinctId` four-step preference | ✅ | `src/telemetry/emit.ts:275-309` | |
| IDX-6  | Registry write per window contract; reads new-first with legacy fallback | ✅ | `src/shared/registry-paths.ts`, `src/install/registry.ts`, `src/daemon/registry.ts` | |
| IDX-7  | Mid-migration portal serves; gate terminates on `/buzzing`; no fabricated health | ✅ | rc-AC-7/8 rows above | |
| IDX-8  | Fresh units reference only `~/.apiary/hive/` paths; old units keep working | ✅ | rr-AC-9/10/11 rows above | |
| IDX-9  | `~/.deeplake/` untouched; no per-project `.honeycomb/` reads | ✅ | Verified: the diff contains zero `deeplake` references; no code path added touches committed project folders | |
| NG-1   | Non-goal: shared-surface ownership stays with doctor | ✅ | hive only upserts its entry and fallback-reads | Honored |
| NG-2   | Non-goal: other products' state untouched | ✅ | Diff confined to hive paths | Honored |
| NG-3   | Non-goal: bootstrap script unchanged | ✅ | Token mint untouched; dual read covers the window | Honored |
| NG-4   | Non-goal: no service unit/label renames | ✅ | `src/service/platform.ts:11-13` unchanged | Honored |
| NG-5   | Non-goal: no Deeplake data/schema change | ✅ | Filesystem-only change | Honored |
| NG-6   | Non-goal: legacy fallbacks not removed | ✅ | All fallbacks present with removal criterion | Honored |

## Gate outputs

- `npm run typecheck`: clean (exit 0).
- `npm test`: 56 files, 384 tests passed, 0 failed (baseline 383 plus the security-audit regression test; meets the 384+ bar).
- Independent rr-AC-7 grep: one path literal `".honeycomb"` in `src/` (`src/shared/legacy-paths.ts:20`), under the removal-criterion module comment. All other grep hits are property accesses (`bases.honeycomb`, `honeycombId`), not paths.
- Independent cwd grep: zero `process.cwd()` reads in `src/` (two comment mentions only).

## Files Changed

- `library/knowledge/private/architecture/ADR-0005-...md` (M), mirror re-synced with the absolute-only amendment and Resolved decision 4 (absolute registry paths)
- `src/daemon/installer/config.ts` (M), token path onto the helper; `legacyTokenPath` seam added
- `src/daemon/installer/token.ts` (M), dual-path lazy read (new first), invalidation deletes both paths
- `src/daemon/registry.ts` (M), read side onto `resolveFleetRegistryPath` + `readRegistryBody` fallback chain
- `src/daemon/server.ts` (M), boot ordering: `migrateState` seam, lock+pid, fail-soft `registerWithDoctor` seam
- `src/install/registry.ts` (M), write side onto `resolveRegistryWritePath`; absolute `pidPath`; mkdirp 0o700 (security F-3)
- `src/lock.ts` (M), legacy-lock liveness guard, stale legacy cleanup, mkdir 0o700 (security F-1)
- `src/service/index.ts` (M), staged task path via helper; install runs the migration seam
- `src/service/templates.ts` (M), launchd log paths via `resolveLaunchdLogPaths`
- `src/shared/apiary-root.ts` (A), the canonical `resolveFleetRoot` chain + hive path derivations (absolute-only env roots)
- `src/shared/constants.ts` (M), `HIVE_PID_PATH`/`HIVE_LOCK_PATH` re-derived; `HONEYCOMB_HOME_DIR` removed (no stale consumers remain)
- `src/shared/legacy-paths.ts` (A), quarantined legacy-window constants with the removal criterion
- `src/shared/registry-paths.ts` (A), window write-target rule + new-then-legacy read chain
- `src/shared/state-migration.ts` (A), one-time additive copy-verify migration, fail-soft
- `src/telemetry/emit.ts` (M), state dir + shared install-id onto the helper; four-step distinct_id preference
- `tests/cli-commands.test.ts` (M), home-isolation seams injected
- `tests/daemon/installer/token-path.test.ts` (A), mg-AC-9/10 dual-read tests
- `tests/daemon/server.test.ts` (M), boot seams injected; rc-AC-2 count assertion
- `tests/install/registry.test.ts` (M), absolute pidPath assertion
- `tests/lock.test.ts` (M), mg-AC-5/6 legacy lock tests
- `tests/service/service-module.test.ts` (M), rr-AC-10 staged path; migration-seam assertion
- `tests/service/templates.test.ts` (M), rr-AC-9 launchd log path test
- `tests/setup/isolate-home.ts` (A), suite-wide temp-home isolation; clears `APIARY_HOME`/`XDG_STATE_HOME`
- `tests/shared/apiary-root.test.ts` (A), rr-AC-1..4 incl. the updated rr-AC-3 absolute-only test
- `tests/shared/registry-paths.test.ts` (A), rc-AC-3..6 tests
- `tests/shared/state-migration.test.ts` (A), mg-AC-1..4 tests
- `tests/telemetry/emit.test.ts` (M), mg-AC-8 preference test
- `vitest.config.ts` (M), registers the isolate-home setup file

(Dashboard files `src/dashboard/web/wire.ts`, `src/dashboard/web/pages/hive-graph.tsx` and their tests belong to nectar PRD-019c; audited in the companion report at `nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/qa/2026-07-04-qa-report-prd-019c-hive-dashboard-surface.md`.)
