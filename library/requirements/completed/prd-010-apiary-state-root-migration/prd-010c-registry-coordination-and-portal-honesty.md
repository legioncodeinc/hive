# PRD-010c: Registry coordination and portal honesty

> Parent: [`prd-010-apiary-state-root-migration-index.md`](./prd-010-apiary-state-root-migration-index.md)

## Overview

hive touches doctor's cross-daemon registry on two sides. The write side: `registerHiveWithDoctor` (`src/install/registry.ts:121-152`) upserts hive's own entry (name, health URL, `pidPath`, probe/restart tuning) into `~/.honeycomb/doctor.daemons.json` via atomic temp-and-rename. The read side: `resolveDaemonBases` and `resolveRegisteredServiceNames` (`src/daemon/registry.ts:113-134`) read the same file to learn where honeycomb and nectar answer and which services should exist, degrading to documented loopback defaults or an empty list when the file is missing or corrupt. Under ADR-0005 the file itself is doctor-managed and relocates to `~/.apiary/registry.json`; hive follows doctor's compatibility window, keeps writing only its own entry, and never becomes the registry's owner.

hive is also the always-on portal, which makes the fleet-wide migration window a user-visible event: doctor, honeycomb, and nectar restart into new paths on their own schedules, the registry may exist at either location, and any source may be transiently unreachable. hive already has the right posture for every one of those conditions individually: an unreachable supervisor renders as `unreachable`, never a throw (`UNREACHABLE_RESPONSE`, `src/daemon/fleet-status.ts:16-19`); a missing/corrupt registry yields defaults, never a crash (`src/daemon/registry.ts:52-54,130-133`); the gate terminates on `/buzzing` when the fleet is unhealthy (`GATE_EXEMPT_ROUTES`, `src/daemon/gate.ts:55`). This sub-PRD's job is to guarantee the same posture holds across the new dual-path conditions, so a mid-migration dashboard is honest (things that are down show as down) rather than broken (a crash) or dishonest (fake green).

Note hive's registry reads resolve daemon *bases* from `healthUrl` values, not from state paths (`baseUrlFromHealthUrl`, `src/daemon/registry.ts:30-46`), and hive's BFF proxy targets loopback ports, not files. So sibling products' own `~/.honeycomb` migrations (which follow their own parallel PRDs) do not change what hive proxies to; hive's exposure is limited to the registry file location and the shared install-id, both covered here and in [`prd-010b`](./prd-010b-first-boot-migration-and-legacy-fallback.md).

## Goals

- hive's registry entry lands in the doctor-owned `~/.apiary/registry.json`, with the entry's `pidPath` naming `~/.apiary/hive/hive.pid`, per the coordination contract with doctor's parallel PRD.
- Registry reads consult the new path first and fall back to the legacy path, so hive resolves daemon bases and service names on a fleet at any point in the migration window.
- The portal's honest-degradation posture provably covers the mid-migration conditions: either registry location, any subset of siblings unreachable, and the moment of hive's own restart.
- The upsert-registration ordering guarantees doctor's watchdog never observes a `pidPath` that disagrees with hive's live pid file long enough to restart-loop hive.

## Non-Goals

- Owning, creating the format of, or migrating `registry.json`, `device.json`, or the fleet-root `install-id`; doctor's parallel PRD owns the shared surface. hive is one writer of one entry and a fallback-tolerant reader.
- Changing the registry entry schema (`buildHiveRegistryEntry`, `src/install/registry.ts:95-105`) or doctor's probe semantics.
- New dashboard UI for the migration; the window reuses the existing `/buzzing`, health rail, and unreachable states. No "migrating..." screen.
- Proxy-target changes; daemon bases remain loopback-pinned health-URL derivations (`src/daemon/registry.ts:30-46`) regardless of where the registry file lives.

---

## User stories + acceptance criteria

### US-1 - registry write coordination

**As** doctor's registry contract, **when** hive registers, **its** entry appears at the relocated path without hive claiming ownership of the file.

| ID | Criterion |
|---|---|
| rc-AC-1 | Given a machine where doctor has migrated (or a fresh machine), when `registerHiveWithDoctor` runs, then hive upserts its entry into `~/.apiary/registry.json` with the same atomic temp-and-rename discipline as today (`src/install/registry.ts:137-146`), preserving all other products' entries and any unknown root keys, and the entry's `pidPath` is the new-path value ([`prd-010a`](./prd-010a-shared-root-helper-and-path-constants.md) rr-AC-8). |
| rc-AC-2 | Given the upgrade boot, when hive first writes its pid to the new path, then it re-registers in the same boot, and the ordering is: acquire lock and write new pid file, then upsert the registry entry naming it; between old-entry/old-pid and new-entry/new-pid there is no state where doctor probes a `pidPath` that has never existed. |
| rc-AC-3 | Given a not-yet-migrated fleet (legacy registry present, no fleet root directory yet), when hive registers, then hive follows the fleet ADR's registry compatibility window contract (RESOLVED 2026-07-04): write to `~/.apiary/registry.json` when the fleet root directory exists, else the legacy path; never write both files. |

### US-2 - registry read fallback

**As** the portal, **when** the registry lives at either location, **I** resolve bases and service names the same way.

| ID | Criterion |
|---|---|
| rc-AC-4 | Given `~/.apiary/registry.json` present, when `resolveDaemonBases` or `resolveRegisteredServiceNames` runs, then it reads the new path and does not consult the legacy path. |
| rc-AC-5 | Given no new-path registry but a legacy `~/.honeycomb/doctor.daemons.json`, when the readers run, then they fall back to the legacy file and produce the same result they would today. |
| rc-AC-6 | Given neither file, or a corrupt file at either location, when the readers run, then behavior is unchanged from today: documented loopback defaults for bases, an empty list for service names, never a throw (`src/daemon/registry.ts:52-54,84,119-121,130-133`). |

### US-3 - the mid-migration portal is honest

**As** the operator watching the always-on portal during the fleet migration, **what** I see is true.

| ID | Criterion |
|---|---|
| rc-AC-7 | Given any sibling daemon down or restarting into its new paths, when the dashboard loads, then fleet status reports it via the existing closed health set (`ok`/`degraded`/`unreachable`/`unknown`, `src/daemon/fleet-status.ts:21`) and the gate redirects to `/buzzing` when the fleet is not ready, exactly the current unreachable-source posture; no route 500s and no screen renders a healthy state it did not observe. |
| rc-AC-8 | Given the registry mid-move (absent at both paths for an instant, or present only at one), when any portal request arrives, then the BFF proxy and setup-auth reads (`src/daemon/proxy.ts:114`, `src/daemon/setup-auth.ts:53`) resolve bases through the fallback chain and degrade to defaults rather than failing the request pipeline. |
| rc-AC-9 | Given hive's own upgrade restart, when the service manager restarts the daemon (the `KeepAlive`/`Restart=always`/schtasks-restart configs in `src/service/templates.ts:39-42,63-64,102-105`), then the portal is back within the manager's restart interval and the first post-restart load passes through the normal gate; no migration step extends the outage beyond the restart itself (mg-AC-3's never-block guarantee). |

---

## Implementation notes

### One fallback chain, shared with prd-010b

The read fallback (new path, then legacy, then defaults) should be one helper used by both `src/daemon/registry.ts` readers and any other legacy-window read, so the removal criterion deletes one module instead of a scatter of conditionals. Every fallback site carries the legacy-window comment required by [`prd-010a`](./prd-010a-shared-root-helper-and-path-constants.md) rr-AC-7.

### Why no new UI

The migration window is operationally indistinguishable from the conditions the portal already handles: a daemon restarting, a supervisor briefly unreachable, a registry not yet written on a cold box. PRD-004's buzzing loaders and PRD-005's health rail already present those states. Inventing a migration-specific screen would add a state that can lie (stuck "migrating" when the real problem is a crash); reusing the honest-unreachable posture cannot.

### Coordination checklist with doctor's parallel PRD

Items (1) and (3) are RESOLVED by the fleet ADR's "Resolved decisions" registry compatibility window contract (confirmed 2026-07-04): the marker is the existence of the fleet root directory itself (write new when it exists, else legacy; never both), and doctor migrates the registry file wholesale on its own first boot; hive's legacy-write branch remains live only for fleets where doctor has not yet booted its migrated build. Still pinned before implementation: (2) the `pidPath` convention in the relocated registry (tilde literal, as `HIVE_REGISTRY_PID_PATH` is today at `src/install/registry.ts:10`, or absolute; honeycomb's 072c flags the same question); (4) the schema is unchanged (assumed, per doctor ADR-0002's contract).

## Related

- [`prd-010-apiary-state-root-migration-index.md`](./prd-010-apiary-state-root-migration-index.md) - the locked shared-surface ownership decision (doctor-managed).
- [`prd-010a-shared-root-helper-and-path-constants.md`](./prd-010a-shared-root-helper-and-path-constants.md) - the constants and `pidPath` value this coordination writes.
- [`prd-010b-first-boot-migration-and-legacy-fallback.md`](./prd-010b-first-boot-migration-and-legacy-fallback.md) - the boot ordering (mg-AC-7) rc-AC-2 completes.
- `src/install/registry.ts:95-152` - `buildHiveRegistryEntry` / `registerHiveWithDoctor`, the write side.
- `src/daemon/registry.ts:30-46,113-134` - `baseUrlFromHealthUrl` and the fail-soft readers, the read side.
- `src/daemon/fleet-status.ts:16-21` - the unreachable posture and closed health set the window reuses.
- `src/daemon/gate.ts:42-55` - `/buzzing` and the gate exemptions that terminate the unhealthy-fleet redirect.
- `src/daemon/proxy.ts:114`, `src/daemon/setup-auth.ts:53` - base-resolving consumers that must ride the fallback chain.
- doctor `ADR-0002-service-registration-static-registry-plus-runtime-sqlite` (cross-repo) - the registry contract whose path moves; doctor's parallel PRD implements the shared-surface relocation.
