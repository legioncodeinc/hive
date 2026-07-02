# PRD-001d: service unit and registration

> Parent: [`prd-001-hive-portal-daemon-index.md`](./prd-001-hive-portal-daemon-index.md)

## Overview

This sub-PRD makes hive a real OS-level citizen. It covers two wiring concerns: (1) **hive's own OS service unit**, the launchd/systemd/schtasks definition that boots hive on device start and restarts it on crash; and (2) **hive's registration** in doctor's daemon registry, the one-step file edit hive's installer performs so doctor supervises it.

Together with [`prd-001a`](./prd-001a-hive-process-and-bootstrap.md) (the process) this delivers the always-on property: hive boots on OS start via its service unit, registers itself so doctor supervises it, and is updateable independently because its service unit is separate from doctor's ([`ADR-0004`](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) decisions #1 and #4).

hive's service path is modeled on doctor's existing service install (`doctor/src/service/index.ts:129-234`) without importing it: the same plan/render/install pattern, a different exec path and label so the two services are fully independent.

## Goals

- hive ships an OS service unit (launchd on macOS, systemd on Linux, schtasks on Windows) that starts hive on boot/login and restarts it on crash.
- hive's service unit is installed/removed by hive's own installer, not by doctor.
- hive registers in doctor's registry via a single idempotent, atomic JSON-file edit, with no doctor restart and no doctor code change.
- hive and doctor are separate services, so updating one does not restart the other.

## Non-Goals

- doctor's registry schema and read-on-boot semantics (owned by doctor's PRD-004a). hive writes an entry conforming to that schema and consumes the registry as a given.
- A runtime registration API. Registration is install-time file edit only.
- hive supervising other daemons. doctor is the only supervisor; hive is a supervised peer.
- A cross-platform service-manager abstraction beyond what doctor's `service/index.ts` already encodes; hive reuses that pattern.

---

## User stories + acceptance criteria

### US-1 - hive boots on OS start

**As** an operator, **when** I install hive, **I** get a service unit that boots it on next login/boot.

| ID | Criterion |
|---|---|
| d-AC-1 | Given hive's installer runs `install-service`, when it resolves the platform (macOS/Linux/Windows via the same environment resolution as `doctor/src/service/index.ts:134-135`), then it writes the platform-appropriate unit file and registers it with the platform service manager. |
| d-AC-2 | Given hive's service unit is registered, when the device boots (or the user logs in), then hive starts automatically. |
| d-AC-3 | Given hive crashes, when the service manager observes the exit, then it restarts hive (launchd `KeepAlive` / systemd `Restart=always` / schtasks trigger-on-failure), matching doctor's "restart on crash and start on boot" contract (`doctor/src/service/index.ts:190`). |

### US-2 - installed and removed independently of doctor

**As** an operator, **when** I uninstall or update hive, **I** do not affect doctor.

| ID | Criterion |
|---|---|
| d-AC-4 | Given hive and doctor are separate service units, when hive's `uninstall-service` runs, then only hive's unit file is removed (mirroring the cleanup at `doctor/src/service/index.ts:208-218`); doctor's unit is untouched. |
| d-AC-5 | Given hive's `install-service`, when it renders the unit, then the unit execs hive's own entrypoint and exec path, never doctor's, so the two services are fully independent (ADR-0004 decision #4). |

### US-3 - hive registers itself in the registry

**As** hive's installer, **when** I run, **I** append hive's entry to doctor's registry.

| ID | Criterion |
|---|---|
| d-AC-6 | Given hive's installer runs, when it finishes, then `~/.honeycomb/doctor.daemons.json` contains a hive entry with `name: "hive"`, `healthUrl`, `pidPath`, and the per-daemon intervals. |
| d-AC-7 | Given the registry already contains a hive entry, when hive's installer re-runs, then it updates that entry in place (idempotent) rather than appending a duplicate. |
| d-AC-8 | Given hive registers, when registration completes, then doctor is NOT restarted and its code is NOT modified; the installer only edits the JSON file atomically (temp + rename). |

---

## Implementation notes

### hive service unit (modeled on doctor's service path)

hive's `install-service`/`uninstall-service` reuses the structure of doctor's `createServiceModule` (`doctor/src/service/index.ts:129-234`):

- Resolve platform + scope via the same environment/plan resolution (`doctor/src/service/index.ts:134-135`).
- Write the unit file first, then run the manager's install argv.
- On uninstall, deregister via the manager then delete the unit file so it cannot resurrect on next boot (`doctor/src/service/index.ts:208-218`).

The difference is the exec path and label: hive's unit execs hive's entrypoint and is labeled `hive` (not `doctor`), so the two services are independent (d-AC-4/d-AC-5). The schtasks staged-XML pattern generalizes to a hive-staged path under `~/.honeycomb/hive/`.

### Registration: the installer edits the registry file

The registry file (`~/.honeycomb/doctor.daemons.json`, owned by doctor's PRD-004a) is the single registration target. hive's installer performs a read-modify-write at install time:

1. Read the file (or treat absence as `{ "daemons": [] }`).
2. Find an entry whose `name` is `hive`; if present, update in place (d-AC-7 idempotency); if absent, append a new entry (d-AC-6).
3. Write atomically (temp + rename), so a partial write never leaves a corrupt registry doctor would fail to parse on boot.
4. Do NOT restart doctor and do NOT modify doctor's code (d-AC-8).

hive's registry entry uses these defaults: `name: "hive"`, `healthUrl: http://127.0.0.1:3853/health`, `pidPath: ~/.honeycomb/hive.pid`, plus the per-daemon probe intervals and restart thresholds the registry schema defines.

### Timing (confirm before implementation)

A freshly-registered daemon is supervised at doctor's next boot, not immediately (the registry is read once on boot). Since both hive and doctor boot on OS start, the new daemon is supervised after the next device boot or doctor restart. Immediate supervision without a full doctor restart would need a registry-reload signal, which is out of scope and flagged as a follow-up.

### Failure handling

A corrupt or unparseable registry must not wedge doctor: doctor's fallback (supervise honeycomb at defaults) handles absence, and a malformed file resolves to the same fallback with a logged warning. hive's installer writes atomically so the window for a partial file is negligible.

## Related

- [`prd-001a-hive-process-and-bootstrap.md`](./prd-001a-hive-process-and-bootstrap.md) - hive's process, `/health`, and PID/lock this service unit boots and this registry entry points at.
- [`prd-001c-api-aggregation-wire.md`](./prd-001c-api-aggregation-wire.md) - the aggregation that routes over the registry entries this sub-PRD writes.
- [nectar ADR-0004](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) - decisions #1 (always-on/boot) and #4 (independent cadence) this sub-PRD realizes.
- [nectar PRD-004d](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004d-hive-service-unit-and-registration.md) - the source service-unit + registration contract this adapts.
- `doctor/src/service/index.ts:129-234` - the service install/uninstall pattern hive mirrors.
