# PRD-001a: thehive process and bootstrap

> Parent: [`prd-001-thehive-portal-daemon-index.md`](./prd-001-thehive-portal-daemon-index.md)

## Overview

This sub-PRD delivers thehive as its own OS-level daemon: a TypeScript/Node + Hono process with its own `/health`, its own single-instance PID/lock guard, and its own port. It is the process foundation the dashboard ([`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)) and the API-aggregation layer ([`prd-001c`](./prd-001c-api-aggregation-wire.md)) mount into, and the process hivedoctor supervises via the registry entry ([`prd-001d`](./prd-001d-service-unit-and-registration.md)).

thehive's server mirrors honeycomb's daemon-server shape (`honeycomb/src/daemon/runtime/server.ts`) without importing it: construct a `Hono` app, mount the dashboard surface, implement `/health`, and bind a socket in a production-only entrypoint (`startThehive`, the analogue of honeycomb's `startDaemon`). This is the always-on foundation for ADR-0004 decision #1: the shell renders the moment the socket binds, before any workload daemon is confirmed healthy.

## Goals

- thehive is a standalone TS/Node + Hono daemon with its own OS process, own `/health`, own PID/lock, and own port (3853).
- thehive's `/health` is a cheap liveness endpoint so hivedoctor's probe gets a fast answer.
- thehive binds its socket and serves the dashboard shell without waiting on any workload daemon's health.
- A single-instance guard prevents two thehive processes from binding the same port and PID.

## Non-Goals

- The dashboard code that mounts into this process (that is [`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)).
- The `wire` aggregation client the pages hydrate through (that is [`prd-001c`](./prd-001c-api-aggregation-wire.md)).
- The OS service unit that boots this process and the registry entry that registers it (that is [`prd-001d`](./prd-001d-service-unit-and-registration.md)).

---

## User stories + acceptance criteria

### US-1 - thehive is its own process

**As** an operator, **when** I start thehive, **I** get a standalone daemon with its own port and health, independent of the workload daemons.

| ID | Criterion |
|---|---|
| a-AC-1 | Given thehive's entrypoint runs, when it starts, then it constructs a Hono app, mounts the dashboard surface, and binds a socket on **port 3853** (the confirmed port from the parent index's contract). |
| a-AC-2 | Given thehive is running, when a client requests `GET /health`, then thehive returns a cheap liveness body (`status` + `uptimeMs` + `version`) with no heavy query, modeled on honeycomb's `/health` (`honeycomb/src/daemon/runtime/server.ts:319-341`). |
| a-AC-3 | Given the process starts, when it binds the socket, then the dashboard shell is served immediately, without any wait on honeycomb's or hivenectar's `/health` (ADR-0004 decision #1). |

### US-2 - single-instance guard

**As** an operator, **when** I accidentally start thehive twice, **I** get exactly one live instance.

| ID | Criterion |
|---|---|
| a-AC-4 | Given thehive starts, when it acquires its guard, then it writes `~/.honeycomb/thehive.pid` and `~/.honeycomb/thehive.lock` (DEFAULT, confirm before implementation) as siblings to the other daemons' files under `~/.honeycomb`. |
| a-AC-5 | Given a thehive instance already holds the lock and is alive, when a second thehive starts, then the second exits rather than binding a second socket on 3853 (mirroring honeycomb's single-instance lock posture). |
| a-AC-6 | Given a stale lock whose PID is no longer alive, when thehive starts, then it reclaims the lock and starts (a liveness check on the recorded PID, not a blind refusal). |

### US-3 - production-only listen

**As** a maintainer, **when** I import thehive's app in a test, **I** can construct it without binding a socket.

| ID | Criterion |
|---|---|
| a-AC-7 | Given thehive's module, when it is imported, then app construction is pure (no socket bound, no service started), and only `startThehive` calls `listen()` in production, mirroring honeycomb's `createDaemon` vs `startDaemon` split (`honeycomb/src/daemon/runtime/server.ts` construction is socket-free; the production listen is a separate entrypoint). |

---

## Implementation notes

### Daemon bootstrap (Hono, modeled on honeycomb's server)

thehive is a TS/Node + Hono daemon. Its HTTP server mirrors honeycomb's `createDaemon` shape: construct a `Hono` app, mount the dashboard surface (`prd-001b`), implement `/health`, and bind a socket in a `startThehive` entrypoint called only in production. honeycomb keeps app construction free of side effects and binds the socket in a separate production path; thehive follows the same split so the app is testable in-process (construct the app, call `app.request(...)`) without a real socket.

thehive's `/health` is coarse and cheap, matching honeycomb's `/health` (`honeycomb/src/daemon/runtime/server.ts:319-341`): a `status` + `uptimeMs` + `version` body, no Deep Lake query (thehive has no Deep Lake client at all). hivedoctor's probe (the registry entry's `healthUrl`, [`prd-001d`](./prd-001d-service-unit-and-registration.md)) reads this for a fast ok/degraded answer.

### Port (CONFIRMED)

thehive serves on **3853**, per the parent index's port contract (inherited from hivenectar's locked map: honeycomb 3850, embeddings 3851, hivedoctor status page 3852, thehive 3853, hivenectar 3854). There is no collision.

### PID/lock (DEFAULT, confirm before implementation)

thehive writes `~/.honeycomb/thehive.pid` and `~/.honeycomb/thehive.lock`, the single-instance guard hivedoctor's restart rung respects via the registry entry's `pidPath`. The `~/.honeycomb` runtime dir is the honeycomb convention, so a single `ls ~/.honeycomb/*.pid` enumerates every live daemon. The guard's stale-lock reclaim uses a liveness check on the recorded PID rather than a blind refusal.

### Always-on independence

Nothing in thehive's boot path awaits a workload daemon. The shell is static and renders on socket bind; per-daemon data hydrates later through the aggregation `wire` ([`prd-001c`](./prd-001c-api-aggregation-wire.md)), which is fail-soft, so a workload that has not answered `/health` yet renders as "starting," never as an error that blanks the page.

## Related

- [`prd-001-thehive-portal-daemon-index.md`](./prd-001-thehive-portal-daemon-index.md) - module scope and the port/path contract.
- [`prd-001b-dashboard-migration-and-copy-map.md`](./prd-001b-dashboard-migration-and-copy-map.md) - the dashboard surface this process mounts.
- [`prd-001c-api-aggregation-wire.md`](./prd-001c-api-aggregation-wire.md) - the `wire` the mounted pages hydrate through.
- [`prd-001d-service-unit-and-registration.md`](./prd-001d-service-unit-and-registration.md) - the service unit + registry entry that boots and supervises this process.
- [hivenectar ADR-0004](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - decision #1 (always-on + boot order) this sub-PRD realizes.
- `honeycomb/src/daemon/runtime/server.ts:319-341` - the `/health` contract thehive's is modeled on.
