# PRD-001a: hive process and bootstrap

> Parent: [`prd-001-hive-portal-daemon-index.md`](./prd-001-hive-portal-daemon-index.md)

## Overview

This sub-PRD delivers hive as its own OS-level daemon: a TypeScript/Node + Hono process with its own `/health`, its own single-instance PID/lock guard, and its own port. It is the process foundation the dashboard ([`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)) and the API-aggregation layer ([`prd-001c`](./prd-001c-api-aggregation-wire.md)) mount into, and the process doctor supervises via the registry entry ([`prd-001d`](./prd-001d-service-unit-and-registration.md)).

hive's server mirrors honeycomb's daemon-server shape (`honeycomb/src/daemon/runtime/server.ts`) without importing it: construct a `Hono` app, mount the dashboard surface, implement `/health`, and bind a socket in a production-only entrypoint (`startHive`, the analogue of honeycomb's `startDaemon`). This is the always-on foundation for ADR-0004 decision #1: the shell renders the moment the socket binds, before any workload daemon is confirmed healthy.

## Goals

- hive is a standalone TS/Node + Hono daemon with its own OS process, own `/health`, own PID/lock, and own port (3853).
- hive's `/health` is a cheap liveness endpoint so doctor's probe gets a fast answer.
- hive binds its socket and serves the dashboard shell without waiting on any workload daemon's health.
- A single-instance guard prevents two hive processes from binding the same port and PID.

## Non-Goals

- The dashboard code that mounts into this process (that is [`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)).
- The `wire` aggregation client the pages hydrate through (that is [`prd-001c`](./prd-001c-api-aggregation-wire.md)).
- The OS service unit that boots this process and the registry entry that registers it (that is [`prd-001d`](./prd-001d-service-unit-and-registration.md)).

---

## User stories + acceptance criteria

### US-1 - hive is its own process

**As** an operator, **when** I start hive, **I** get a standalone daemon with its own port and health, independent of the workload daemons.

| ID | Criterion |
|---|---|
| a-AC-1 | Given hive's entrypoint runs, when it starts, then it constructs a Hono app, mounts the dashboard surface, and binds a socket on **port 3853** (the confirmed port from the parent index's contract). |
| a-AC-2 | Given hive is running, when a client requests `GET /health`, then hive returns a cheap liveness body (`status` + `uptimeMs` + `version`) with no heavy query, modeled on honeycomb's `/health` (`honeycomb/src/daemon/runtime/server.ts:319-341`). |
| a-AC-3 | Given the process starts, when it binds the socket, then the dashboard shell is served immediately, without any wait on honeycomb's or nectar's `/health` (ADR-0004 decision #1). |

### US-2 - single-instance guard

**As** an operator, **when** I accidentally start hive twice, **I** get exactly one live instance.

| ID | Criterion |
|---|---|
| a-AC-4 | Given hive starts, when it acquires its guard, then it writes `~/.honeycomb/hive.pid` and `~/.honeycomb/hive.lock` (DEFAULT, confirm before implementation) as siblings to the other daemons' files under `~/.honeycomb`. |
| a-AC-5 | Given a hive instance already holds the lock and is alive, when a second hive starts, then the second exits rather than binding a second socket on 3853 (mirroring honeycomb's single-instance lock posture). |
| a-AC-6 | Given a stale lock whose PID is no longer alive, when hive starts, then it reclaims the lock and starts (a liveness check on the recorded PID, not a blind refusal). |

### US-3 - production-only listen

**As** a maintainer, **when** I import hive's app in a test, **I** can construct it without binding a socket.

| ID | Criterion |
|---|---|
| a-AC-7 | Given hive's module, when it is imported, then app construction is pure (no socket bound, no service started), and only `startHive` calls `listen()` in production, mirroring honeycomb's `createDaemon` vs `startDaemon` split (`honeycomb/src/daemon/runtime/server.ts` construction is socket-free; the production listen is a separate entrypoint). |

---

## Implementation notes

### Daemon bootstrap (Hono, modeled on honeycomb's server)

hive is a TS/Node + Hono daemon. Its HTTP server mirrors honeycomb's `createDaemon` shape: construct a `Hono` app, mount the dashboard surface (`prd-001b`), implement `/health`, and bind a socket in a `startHive` entrypoint called only in production. honeycomb keeps app construction free of side effects and binds the socket in a separate production path; hive follows the same split so the app is testable in-process (construct the app, call `app.request(...)`) without a real socket.

hive's `/health` is coarse and cheap, matching honeycomb's `/health` (`honeycomb/src/daemon/runtime/server.ts:319-341`): a `status` + `uptimeMs` + `version` body, no Deep Lake query (hive has no Deep Lake client at all). doctor's probe (the registry entry's `healthUrl`, [`prd-001d`](./prd-001d-service-unit-and-registration.md)) reads this for a fast ok/degraded answer.

### Port (CONFIRMED)

hive serves on **3853**, per the parent index's port contract (inherited from nectar's locked map: honeycomb 3850, embeddings 3851, doctor status page 3852, hive 3853, nectar 3854). There is no collision.

### PID/lock (DEFAULT, confirm before implementation)

hive writes `~/.honeycomb/hive.pid` and `~/.honeycomb/hive.lock`, the single-instance guard doctor's restart rung respects via the registry entry's `pidPath`. The `~/.honeycomb` runtime dir is the honeycomb convention, so a single `ls ~/.honeycomb/*.pid` enumerates every live daemon. The guard's stale-lock reclaim uses a liveness check on the recorded PID rather than a blind refusal.

### Always-on independence

Nothing in hive's boot path awaits a workload daemon. The shell is static and renders on socket bind; per-daemon data hydrates later through the aggregation `wire` ([`prd-001c`](./prd-001c-api-aggregation-wire.md)), which is fail-soft, so a workload that has not answered `/health` yet renders as "starting," never as an error that blanks the page.

## Related

- [`prd-001-hive-portal-daemon-index.md`](./prd-001-hive-portal-daemon-index.md) - module scope and the port/path contract.
- [`prd-001b-dashboard-migration-and-copy-map.md`](./prd-001b-dashboard-migration-and-copy-map.md) - the dashboard surface this process mounts.
- [`prd-001c-api-aggregation-wire.md`](./prd-001c-api-aggregation-wire.md) - the `wire` the mounted pages hydrate through.
- [`prd-001d-service-unit-and-registration.md`](./prd-001d-service-unit-and-registration.md) - the service unit + registry entry that boots and supervises this process.
- [nectar ADR-0004](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) - decision #1 (always-on + boot order) this sub-PRD realizes.
- `honeycomb/src/daemon/runtime/server.ts:319-341` - the `/health` contract hive's is modeled on.
