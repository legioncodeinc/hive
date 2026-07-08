# PRD-010b: First-boot migration and legacy fallback

> Parent: [`prd-010-apiary-state-root-migration-index.md`](./prd-010-apiary-state-root-migration-index.md)

## Overview

[`prd-010a`](./prd-010a-shared-root-helper-and-path-constants.md) makes `~/.apiary/hive/` the default; this sub-PRD makes that default safe on a machine that already has hive state under `~/.honeycomb`. Per ADR-0005's migration rules: on first boot after upgrade, hive performs a one-time migration of its own files; the migration is idempotent and additive; it never deletes a legacy file it did not successfully migrate; and until the fleet finishes migrating, readers fall back to the legacy location when the new path is absent.

The hive-owned migration set (from the parent's inventory): the state dir contents at `~/.honeycomb/hive/` (`install-id`, `telemetry.json`, the onboarding session ledger, a staged `hive-task.xml`, launchd log files, and a possibly-live `onboarding-token`), plus the top-level `hive.pid` and `hive.lock`. The pid and lock files get special treatment: they represent a live process, so they are not blindly copied; the upgrade boot itself re-creates them at the new location under the existing single-instance discipline (`acquireSingleInstanceLock`, `src/lock.ts:50-90`).

Two files hive reads but does not own stay put and get fallback reads instead of migration: the shared `~/.honeycomb/install-id` (honeycomb-installer-written today, relocating to `~/.apiary/install-id` under doctor's parallel PRD; hive's read at `src/telemetry/emit.ts:275-282`) and doctor's registry (handled in [`prd-010c`](./prd-010c-registry-coordination-and-portal-honesty.md)).

## Goals

- A one-time, idempotent, additive migration step in the daemon boot path (and mirrored in `hive install`, so a service re-install also converges) moves hive-owned files from `~/.honeycomb/hive/` into `~/.apiary/hive/`.
- pid/lock continuity: at no point during the upgrade boot can two hive instances both believe they hold the single-instance lock, and a crash mid-migration leaves a bootable state.
- Legacy-fallback reads for the two windows hive does not control: the shared install-id (fleet root first, legacy second, own id third) and the onboarding token (new path first, legacy path second, until the bootstrap's mint moves).
- A migration failure is fail-soft: the daemon still boots, serves `/health`, and logs what it could not move; it retries on next boot.

## Non-Goals

- Migrating the registry file or any other product's files (doctor's parallel PRD owns `doctor.daemons.json` -> `registry.json`; honeycomb/nectar own their own subdirs).
- Deleting the legacy `~/.honeycomb` directory itself, even when empty of hive files; other products may still be mid-window, and the shared files (`install-id`, `device.json`, the registry) are doctor's to relocate.
- The bootstrap script's token-mint path change (honeycomb repo; coordination item below).
- Removing any fallback read; removal is gated on the fleet-wide criterion in the ADR.

---

## User stories + acceptance criteria

### US-1 - the one-time migration

**As** an existing hive install, **when** I boot the upgraded build for the first time, **my** state follows me to the new root without loss.

| ID | Criterion |
|---|---|
| mg-AC-1 | Given legacy files at `~/.honeycomb/hive/` and no `~/.apiary/hive/`, when the upgraded daemon boots, then the state-dir contents (at minimum `install-id`, `telemetry.json`, the onboarding session ledger file) exist under `~/.apiary/hive/` afterward, with content byte-identical to the legacy originals. |
| mg-AC-2 | Given the migration already ran, when the daemon boots again, then no migration work is repeated: files already present at the new path are never overwritten by legacy copies (a newer new-path file always wins), and the boot path performs no writes it does not need. |
| mg-AC-3 | Given a copy failure mid-migration (disk full, permission error), when the boot continues, then every legacy file not successfully migrated remains untouched at its legacy path, the daemon still boots and serves `/health`, and the next boot retries the remainder. |
| mg-AC-4 | Given a fresh machine with no legacy state, when the daemon boots, then no legacy path is created or probed beyond a single existence check, and `~/.apiary/hive/` is created with mode 0o700 (matching `src/telemetry/emit.ts:295`). |

### US-2 - pid/lock continuity across the upgrade boot

**As** doctor's watchdog and as the operator, **when** hive upgrades, **exactly** one instance runs and its pid file is where the registry says it is.

| ID | Criterion |
|---|---|
| mg-AC-5 | Given an old-build hive still running (lock at `~/.honeycomb/hive.lock`), when a new-build hive starts, then the new build detects the live legacy lock and refuses to double-start (extending the `isPidAlive` check in `acquireSingleInstanceLock`, `src/lock.ts:55-69`, to consult the legacy lock location before claiming the new one). |
| mg-AC-6 | Given a clean upgrade restart (old daemon stopped, then new daemon started, the sequence every service manager in `src/service/` produces), when the new build boots, then it acquires the lock at `~/.apiary/hive/hive.lock`, writes its pid to `~/.apiary/hive/hive.pid`, and best-effort removes the stale legacy `hive.pid`/`hive.lock` files (they are process-lifetime files, not data; a leftover stale pair must not strand future boots). |
| mg-AC-7 | Given doctor probing the `pidPath` from hive's registry entry, when the upgrade window is in flight, then the entry hive last wrote and the pid file hive actually maintains never disagree long enough to trigger doctor's restart-give-up path: hive re-registers (upserting the new `pidPath`) in the same boot that first writes the new pid file (ordering pinned in [`prd-010c`](./prd-010c-registry-coordination-and-portal-honesty.md) rc-AC-2). |

### US-3 - legacy fallback reads

**As** an existing install mid-fleet-migration, **when** shared files have not moved yet, **hive** still finds them.

| ID | Criterion |
|---|---|
| mg-AC-8 | Given `resolveDistinctId` (`src/telemetry/emit.ts:275-301`), when resolving, then the preference order becomes: `~/.apiary/install-id`, then legacy `~/.honeycomb/install-id`, then hive's own persisted id, then a fresh UUID; an install with only the legacy shared id keeps its funnel correlation unchanged. |
| mg-AC-9 | Given the onboarding token read (`src/daemon/installer/token.ts`, lazy per-request read of `ONBOARDING_TOKEN_PATH`), when the token is absent at the new path, then the daemon also checks the legacy `~/.honeycomb/hive/onboarding-token`, preserving the mode-0600 and constant-time-compare contract; token invalidation on completion deletes whichever path served it. |
| mg-AC-10 | Given any fallback read, when the new path exists, then the legacy path is not consulted for that read (new wins; fallback is absence-triggered only, per the ADR). |

---

## Implementation notes

### Where the migration runs

A `migrateHiveState()` step early in daemon boot, before `acquireSingleInstanceLock` claims the new-path lock (so the state dir exists) but after the legacy-liveness check (mg-AC-5, so a live old daemon is never raced). `hive install` runs the same function so a service re-install converges a machine even if the daemon never booted between upgrades. Copy-then-verify-then-optionally-remove, never `rename` across the boundary blindly: `~/.honeycomb` and `~/.apiary` are same-volume in the default layout, but `APIARY_HOME` can point anywhere, so EXDEV must be handled; and per the ADR the legacy original is removed only after a successful copy (and never for the shared files hive does not own).

### The launchd log files

`launchd.out.log`/`launchd.err.log` under the legacy dir are not migrated (they are logs, and launchd holds them open while the service runs); freshly rendered units point at the new paths ([`prd-010a`](./prd-010a-shared-root-helper-and-path-constants.md) rr-AC-9) and old logs age out with the legacy directory. DEFAULT - confirm before implementation: whether `hive install` should copy the tail of the legacy logs for support continuity (default: no).

### Bootstrap coordination (token window)

The bootstrap mints the token at the legacy path today (PRD-009d contract; `src/daemon/installer/token.ts:4`). Order of operations across repos: hive ships the dual-location read (mg-AC-9) first; the bootstrap moves its write to `~/.apiary/hive/onboarding-token` in the honeycomb repo's parallel work; the legacy token read is removed with the rest of the fallbacks. A hive that shipped only the new-path read before the bootstrap moved would break onboarding, which is why the dual read is an AC, not a nicety.

### Portal honesty during migration

The boot-time migration is fast (a handful of small files), but the fleet-wide window is long: doctor, honeycomb, and nectar migrate on their own schedules. The portal-facing consequences (registry at either path, sibling daemons restarting into new paths, sources transiently unreachable) are specified in [`prd-010c`](./prd-010c-registry-coordination-and-portal-honesty.md); this sub-PRD's only portal obligation is that the migration itself never blocks or crashes boot (mg-AC-3), so the always-on portal stays up.

## Related

- [`prd-010-apiary-state-root-migration-index.md`](./prd-010-apiary-state-root-migration-index.md) - inventory and locked decisions.
- [`prd-010a-shared-root-helper-and-path-constants.md`](./prd-010a-shared-root-helper-and-path-constants.md) - the new defaults this migration backfills.
- [`prd-010c-registry-coordination-and-portal-honesty.md`](./prd-010c-registry-coordination-and-portal-honesty.md) - registry ordering (rc-AC-2) and the mid-migration portal posture.
- `src/lock.ts:50-103` - `acquireSingleInstanceLock` / `releaseSingleInstanceLock` / `isLockHeldByLiveDaemon`, the single-instance discipline mg-AC-5/6 extend.
- `src/telemetry/emit.ts:275-301` - `resolveDistinctId`, the three-step preference order mg-AC-8 extends to four.
- `src/daemon/installer/token.ts` - the lazy, constant-time token contract mg-AC-9 preserves.
- `src/service/index.ts:160-169` - the decision-#32 best-effort legacy-unit cleanup, the precedent for never-block migration behavior.
- hive [`prd-009d-thin-bootstrap-companion`](../../in-work/prd-009-onboarding-installer/prd-009d-thin-bootstrap-companion.md) - the bootstrap whose token-mint path must follow (cross-repo coordination).
