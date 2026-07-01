# PRD-001d: service unit and registration

> Parent: [`prd-001-thehive-portal-daemon-index.md`](./prd-001-thehive-portal-daemon-index.md)

## Overview

This sub-PRD makes thehive a real OS-level citizen. It covers two wiring concerns: (1) **thehive's own OS service unit**, the launchd/systemd/schtasks definition that boots thehive on device start and restarts it on crash; and (2) **thehive's registration** in hivedoctor's daemon registry, the one-step file edit thehive's installer performs so hivedoctor supervises it.

Together with [`prd-001a`](./prd-001a-thehive-process-and-bootstrap.md) (the process) this delivers the always-on property: thehive boots on OS start via its service unit, registers itself so hivedoctor supervises it, and is updateable independently because its service unit is separate from hivedoctor's ([`ADR-0004`](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) decisions #1 and #4).

thehive's service path is modeled on hivedoctor's existing service install (`hivedoctor/src/service/index.ts:129-234`) without importing it: the same plan/render/install pattern, a different exec path and label so the two services are fully independent.

## Goals

- thehive ships an OS service unit (launchd on macOS, systemd on Linux, schtasks on Windows) that starts thehive on boot/login and restarts it on crash.
- thehive's service unit is installed/removed by thehive's own installer, not by hivedoctor.
- thehive registers in hivedoctor's registry via a single idempotent, atomic JSON-file edit, with no hivedoctor restart and no hivedoctor code change.
- thehive and hivedoctor are separate services, so updating one does not restart the other.

## Non-Goals

- hivedoctor's registry schema and read-on-boot semantics (owned by hivedoctor's PRD-004a). thehive writes an entry conforming to that schema and consumes the registry as a given.
- A runtime registration API. Registration is install-time file edit only.
- thehive supervising other daemons. hivedoctor is the only supervisor; thehive is a supervised peer.
- A cross-platform service-manager abstraction beyond what hivedoctor's `service/index.ts` already encodes; thehive reuses that pattern.

---

## User stories + acceptance criteria

### US-1 - thehive boots on OS start

**As** an operator, **when** I install thehive, **I** get a service unit that boots it on next login/boot.

| ID | Criterion |
|---|---|
| d-AC-1 | Given thehive's installer runs `install-service`, when it resolves the platform (macOS/Linux/Windows via the same environment resolution as `hivedoctor/src/service/index.ts:134-135`), then it writes the platform-appropriate unit file and registers it with the platform service manager. |
| d-AC-2 | Given thehive's service unit is registered, when the device boots (or the user logs in), then thehive starts automatically. |
| d-AC-3 | Given thehive crashes, when the service manager observes the exit, then it restarts thehive (launchd `KeepAlive` / systemd `Restart=always` / schtasks trigger-on-failure), matching hivedoctor's "restart on crash and start on boot" contract (`hivedoctor/src/service/index.ts:190`). |

### US-2 - installed and removed independently of hivedoctor

**As** an operator, **when** I uninstall or update thehive, **I** do not affect hivedoctor.

| ID | Criterion |
|---|---|
| d-AC-4 | Given thehive and hivedoctor are separate service units, when thehive's `uninstall-service` runs, then only thehive's unit file is removed (mirroring the cleanup at `hivedoctor/src/service/index.ts:208-218`); hivedoctor's unit is untouched. |
| d-AC-5 | Given thehive's `install-service`, when it renders the unit, then the unit execs thehive's own entrypoint and exec path, never hivedoctor's, so the two services are fully independent (ADR-0004 decision #4). |

### US-3 - thehive registers itself in the registry

**As** thehive's installer, **when** I run, **I** append thehive's entry to hivedoctor's registry.

| ID | Criterion |
|---|---|
| d-AC-6 | Given thehive's installer runs, when it finishes, then `~/.honeycomb/hivedoctor.daemons.json` contains a thehive entry with `name: "thehive"`, `healthUrl`, `pidPath`, and the per-daemon intervals. |
| d-AC-7 | Given the registry already contains a thehive entry, when thehive's installer re-runs, then it updates that entry in place (idempotent) rather than appending a duplicate. |
| d-AC-8 | Given thehive registers, when registration completes, then hivedoctor is NOT restarted and its code is NOT modified; the installer only edits the JSON file atomically (temp + rename). |

---

## Implementation notes

### thehive service unit (modeled on hivedoctor's service path)

thehive's `install-service`/`uninstall-service` reuses the structure of hivedoctor's `createServiceModule` (`hivedoctor/src/service/index.ts:129-234`):

- Resolve platform + scope via the same environment/plan resolution (`hivedoctor/src/service/index.ts:134-135`).
- Write the unit file first, then run the manager's install argv.
- On uninstall, deregister via the manager then delete the unit file so it cannot resurrect on next boot (`hivedoctor/src/service/index.ts:208-218`).

The difference is the exec path and label: thehive's unit execs thehive's entrypoint and is labeled `thehive` (not `hivedoctor`), so the two services are independent (d-AC-4/d-AC-5). The schtasks staged-XML pattern generalizes to a thehive-staged path under `~/.honeycomb/thehive/`.

### Registration: the installer edits the registry file

The registry file (`~/.honeycomb/hivedoctor.daemons.json`, owned by hivedoctor's PRD-004a) is the single registration target. thehive's installer performs a read-modify-write at install time:

1. Read the file (or treat absence as `{ "daemons": [] }`).
2. Find an entry whose `name` is `thehive`; if present, update in place (d-AC-7 idempotency); if absent, append a new entry (d-AC-6).
3. Write atomically (temp + rename), so a partial write never leaves a corrupt registry hivedoctor would fail to parse on boot.
4. Do NOT restart hivedoctor and do NOT modify hivedoctor's code (d-AC-8).

thehive's registry entry uses these defaults: `name: "thehive"`, `healthUrl: http://127.0.0.1:3853/health`, `pidPath: ~/.honeycomb/thehive.pid`, plus the per-daemon probe intervals and restart thresholds the registry schema defines.

### Timing (confirm before implementation)

A freshly-registered daemon is supervised at hivedoctor's next boot, not immediately (the registry is read once on boot). Since both thehive and hivedoctor boot on OS start, the new daemon is supervised after the next device boot or hivedoctor restart. Immediate supervision without a full hivedoctor restart would need a registry-reload signal, which is out of scope and flagged as a follow-up.

### Failure handling

A corrupt or unparseable registry must not wedge hivedoctor: hivedoctor's fallback (supervise honeycomb at defaults) handles absence, and a malformed file resolves to the same fallback with a logged warning. thehive's installer writes atomically so the window for a partial file is negligible.

## Related

- [`prd-001a-thehive-process-and-bootstrap.md`](./prd-001a-thehive-process-and-bootstrap.md) - thehive's process, `/health`, and PID/lock this service unit boots and this registry entry points at.
- [`prd-001c-api-aggregation-wire.md`](./prd-001c-api-aggregation-wire.md) - the aggregation that routes over the registry entries this sub-PRD writes.
- [hivenectar ADR-0004](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - decisions #1 (always-on/boot) and #4 (independent cadence) this sub-PRD realizes.
- [hivenectar PRD-004d](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004d-thehive-service-unit-and-registration.md) - the source service-unit + registration contract this adapts.
- `hivedoctor/src/service/index.ts:129-234` - the service install/uninstall pattern thehive mirrors.
