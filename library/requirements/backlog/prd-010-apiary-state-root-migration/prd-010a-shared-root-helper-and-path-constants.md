# PRD-010a: Shared root helper and path constants

> Parent: [`prd-010-apiary-state-root-migration-index.md`](./prd-010-apiary-state-root-migration-index.md)

## Overview

Every hive runtime path today derives from one constant, `HONEYCOMB_HOME_DIR = join(homedir(), ".honeycomb")` (`src/shared/constants.ts:20`), plus two hand-built string paths that bypass it: the staged Windows task unit (`stagedWindowsTaskPath`, `src/service/index.ts:101-103`, returning `` `${home}/.honeycomb/hive/hive-task.xml` ``) and the launchd log paths rendered into the plist (`src/service/templates.ts:46,48`). This sub-PRD introduces the fleet-root resolution helper defined by ADR-0005 and rewires every hive path constant onto it, so that the entire inventory in the parent PRD's table resolves to `~/.apiary/hive/` (or, for the shared coordination files, `~/.apiary/`) through one function.

The helper implements the canonical `resolveFleetRoot` chain from the fleet ADR's "Resolved decisions" (confirmed 2026-07-04): `APIARY_HOME` environment variable (the installer's `--home=` pin is delivered as `APIARY_HOME` in the service environment), then `$XDG_STATE_HOME/apiary` on Linux only when `$XDG_STATE_HOME` is explicitly set, then `<os.homedir()>/.apiary`. There is no `~/.local/state` default. It is anchored on `os.homedir()` and never consults `process.cwd()`; the cwd footgun that caused nectar's brooding regression must be structurally impossible in the state-resolution chain.

## Goals

- One exported helper (proposed: `resolveApiaryRoot()` plus `resolveHiveStateDir()` in `src/shared/`) implements the full precedence chain and is the single source of the fleet root.
- Every constant in the parent's inventory table resolves through the helper: `HIVE_PID_PATH`, `HIVE_LOCK_PATH` (`src/shared/constants.ts:21-22`), `HIVE_STATE_DIR` (`src/telemetry/emit.ts:96`), `SHARED_INSTALL_ID_PATH` (`src/telemetry/emit.ts:102`), `ONBOARDING_TOKEN_PATH` (`src/daemon/installer/config.ts:29`), both `DOCTOR_REGISTRY_PATH` declarations (`src/install/registry.ts:6`, `src/daemon/registry.ts:8`), `HIVE_REGISTRY_PID_PATH` (`src/install/registry.ts:10`), the staged Windows task path (`src/service/index.ts:101-103`), and the launchd log paths (`src/service/templates.ts:46,48`).
- Rendered service units carry the resolved-at-render-time paths, satisfying the ADR's installer requirement to pin the resolved root into service units for the Windows LocalSystem enterprise opt-in edge.
- Existing test seams survive: every module already accepts path overrides (`resolveLockPaths` in `src/lock.ts:20-25`, `registryPath` options throughout `src/daemon/registry.ts` and `src/install/registry.ts`, `stateDir` in `src/telemetry/emit.ts:337`, `tokenPath` in `src/daemon/installer/config.ts:106`); the helper changes defaults only.

## Non-Goals

- The migration of existing on-disk files (that is [`prd-010b`](./prd-010b-first-boot-migration-and-legacy-fallback.md)); this sub-PRD only makes new paths the defaults.
- The registry read fallback and write coordination (that is [`prd-010c`](./prd-010c-registry-coordination-and-portal-honesty.md)); this sub-PRD only relocates the default constants those flows use.
- Any change to `~/.deeplake/` or the honeycomb `/setup/state` auth read (`src/daemon/setup-auth.ts:53`).
- Service unit or label renames (`SERVICE_LABEL`, `SYSTEMD_UNIT_NAME`, `WINDOWS_TASK_NAME`, `src/service/platform.ts:11-13` stay as they are).

---

## User stories + acceptance criteria

### US-1 - one resolution chain

**As** the fleet's operator, **when** I set `APIARY_HOME` (or nothing at all), **every** hive path lands where the ADR says it must.

| ID | Criterion |
|---|---|
| rr-AC-1 | Given no overrides, when the helper resolves on macOS or Windows, then the root is `<os.homedir()>/.apiary` and hive's state dir is `<root>/hive`; on Linux with `$XDG_STATE_HOME` set, the root is `$XDG_STATE_HOME/apiary`; on Linux without it, `<os.homedir()>/.apiary` (RESOLVED per the fleet ADR's "Resolved decisions": XDG only when explicitly set, no `~/.local/state` default, and the chain is purely environmental; the helper never scans the disk for existing roots to decide precedence). |
| rr-AC-2 | Given `APIARY_HOME` set to an absolute path, when the helper resolves, then that path wins over every other source, including the `--home=` flag value and XDG. |
| rr-AC-3 | Given any resolution input, when audited, then no code path in the helper (or in any caller supplying its inputs) reads `process.cwd()`; a relative `APIARY_HOME` is rejected or resolved against `os.homedir()`, never against the working directory. |
| rr-AC-4 | Given the helper, when hive and the sibling products resolve the root on the same machine with the same inputs, then they agree byte-for-byte (the chain semantics match the ADR text exactly, so the mirrored helpers cannot diverge). |

### US-2 - constants rewired

**As** a hive developer, **when** I read any path constant, **it** derives from the helper, not from a `.honeycomb` literal.

| ID | Criterion |
|---|---|
| rr-AC-5 | Given the shipped build, when `hive start` runs on a fresh machine, then the pid file and lock file are created at `~/.apiary/hive/hive.pid` and `~/.apiary/hive/hive.lock` (via `resolveLockPaths` defaults, `src/lock.ts:20-25`), and the parent directory is created with the same recursive-mkdir behavior as today (`src/lock.ts:52`). |
| rr-AC-6 | Given the telemetry surface, when `resolveDistinctId` or the ledgers run with no overrides, then `HIVE_STATE_DIR` is `~/.apiary/hive/` (mode 0o700 on create, unchanged from `src/telemetry/emit.ts:295`), and `ONBOARDING_TOKEN_PATH` and the onboarding session ledger (`src/telemetry/onboarding-session-ledger.ts:98`) follow it. |
| rr-AC-7 | Given a repo-wide search of `src/` after implementation, when grepping for the literal `.honeycomb`, then the only remaining occurrences are the legacy-fallback constants introduced by [`prd-010b`](./prd-010b-first-boot-migration-and-legacy-fallback.md) and [`prd-010c`](./prd-010c-registry-coordination-and-portal-honesty.md), each commented as legacy-window code with the removal criterion. |
| rr-AC-8 | Given `HIVE_REGISTRY_PID_PATH` (the tilde-literal doctor's watchdog reads, `src/install/registry.ts:10`), when hive registers, then the entry names `~/.apiary/hive/hive.pid`, in whatever tilde/absolute convention doctor's parallel PRD specifies for the relocated registry (coordination item, [`prd-010c`](./prd-010c-registry-coordination-and-portal-honesty.md)). |

### US-3 - units render the new paths

**As** the installer, **when** I render a service unit, **its** embedded paths point at the fleet root.

| ID | Criterion |
|---|---|
| rr-AC-9 | Given `hive install` on macOS, when the plist renders (`renderLaunchdPlist`, `src/service/templates.ts:20-52`), then `StandardOutPath`/`StandardErrorPath` are `${home}/.apiary/hive/launchd.out.log` and `.err.log`, where `${home}` reflects the resolved root (not a hardcoded `~/.apiary` when `APIARY_HOME` overrides it). |
| rr-AC-10 | Given `hive install` on Windows, when the task XML stages, then it stages to `<root>/hive/hive-task.xml` (replacing `stagedWindowsTaskPath`'s literal, `src/service/index.ts:101-103`), and the enterprise LocalSystem opt-in path pins the installing user's resolved root per the ADR's Windows edge. |
| rr-AC-11 | Given an already-installed unit rendered before this PRD, when the daemon upgrades without re-running `hive install`, then nothing breaks: the old unit still starts the daemon (unit paths only affect log destinations and staging, not daemon correctness), and the next `hive install` re-render adopts the new paths. |

---

## Implementation notes

### Where the helper lives

`src/shared/` beside `constants.ts`, mirroring (not importing) the fleet-wide helper per the fleet's mirror-not-import posture (DEFAULT - confirm before implementation, see the parent's open questions). `constants.ts` keeps exporting the same names (`HIVE_PID_PATH`, `HIVE_LOCK_PATH`) so consumers do not churn; `HONEYCOMB_HOME_DIR` is renamed or re-scoped to the legacy-fallback module rather than silently repointed, so no caller accidentally treats the legacy dir as current.

### The `--home=` seam

Only `hive install` accepts `--home=` (parent open question). The install flow resolves the root once, passes it through `ServiceEnvironment` (which already carries `home`, `src/service/platform.ts:20-24`), and renders it into the unit. The runtime daemon reads only env/XDG/homedir, so a unit rendered with a pinned root and a daemon started by that unit agree because the installer also writes `APIARY_HOME` into the unit's environment block when a non-default root is chosen.

**Windows env-pinning caveat (open-question note, recorded 2026-07-04 during QA remediation).** The launchd plist (`EnvironmentVariables` dict) and the systemd unit (`Environment=` line) pin `APIARY_HOME` when the resolved root differs from the default `<home>/.apiary` (`apiaryHomePin`, `src/service/templates.ts`). The Task Scheduler task XML has no environment block, and wrapping the task action in a shell to inject env is rejected because the Arguments string must remain free of shell interpolation (the XML-escape metacharacter guard is the whole defense). Consequence: a Windows install under an active `APIARY_HOME` override renders staged/unit paths under the override root at render time, but the task-started daemon resolves the default root unless the operator sets `APIARY_HOME` at the user or machine level. hive's Windows service is per-user `InteractiveToken` only, so no LocalSystem edge exists in this repo. This is a documented limitation, not an implemented pin; revisit when the installer's cross-dialect `--home=` work lands.

### Two `DOCTOR_REGISTRY_PATH` declarations

`src/install/registry.ts:6` (write side) and `src/daemon/registry.ts:8` (read side) declare the same constant independently. Both move to the helper in this sub-PRD; consolidating them into one shared declaration is encouraged but not required.

## Related

- [`prd-010-apiary-state-root-migration-index.md`](./prd-010-apiary-state-root-migration-index.md) - the inventory table and locked decisions.
- [`prd-010b-first-boot-migration-and-legacy-fallback.md`](./prd-010b-first-boot-migration-and-legacy-fallback.md) - the migration that makes the new defaults safe on upgraded machines.
- [`prd-010c-registry-coordination-and-portal-honesty.md`](./prd-010c-registry-coordination-and-portal-honesty.md) - the registry path coordination with doctor.
- `src/shared/constants.ts:20-22` - the anchor constants.
- `src/service/platform.ts:35-41` - `resolveServiceContext`, the `home` seam the installer threads the resolved root through.
- `src/service/templates.ts:46,48` and `src/service/index.ts:101-103` - the two hand-built `.honeycomb` paths outside `constants.ts`.
