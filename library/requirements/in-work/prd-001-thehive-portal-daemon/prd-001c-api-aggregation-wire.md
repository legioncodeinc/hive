# PRD-001c: API aggregation wire

> Parent: [`prd-001-thehive-portal-daemon-index.md`](./prd-001-thehive-portal-daemon-index.md)

## Overview

This sub-PRD delivers thehive's federated `wire` client, the one load-bearing modification of the dashboard migration ([`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)). It implements [`ADR-0004`](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) decision #2: thehive holds **no** Deep Lake client and fetches every dashboard row from the **owning** daemon's HTTP API, aggregating fail-soft per daemon.

honeycomb's dashboard `wire` (`honeycomb/src/dashboard/web/wire.ts`) is a thin client over a single same-origin daemon: it declares an endpoint map (`ENDPOINTS`, `honeycomb/src/dashboard/web/wire.ts:34-40`) and a zod schema per endpoint, and fetches each from the one daemon that serves the page. thehive keeps the endpoint map and the schemas but changes the fetch target: each endpoint is routed to the daemon that owns it, resolved through hivedoctor's registry, and a daemon being unreachable degrades only its panels.

## Goals

- thehive's `wire` routes each dashboard endpoint to the owning daemon's `/api/*` base, not a single same-origin.
- Aggregation is fail-soft per daemon: one daemon down degrades its panels to empty/unreachable while the rest of the dashboard renders.
- thehive holds no Deep Lake client, no tenancy scope, and no query surface (ADR-0004 decision #2).
- The endpoint-to-owner routing table is derived from hivedoctor's registry, so a new workload daemon joins by exposing an API, not by a thehive code change to the fetch base.

## Non-Goals

- The dashboard components that consume `wire` (copied in [`prd-001b`](./prd-001b-dashboard-migration-and-copy-map.md)); they are unchanged and consume `wire` through `PageProps`.
- hivedoctor's registry schema and file (owned by hivedoctor's PRD-004a); thehive reads it as the routing source.
- The workload daemons' own `/api/*` shapes; honeycomb's are at `honeycomb/src/daemon/runtime/server.ts:73-107`, hivenectar's Source Graph API is its own PRD. thehive consumes them, does not define them.

---

## User stories + acceptance criteria

### US-1 - per-daemon endpoint routing

**As** a dashboard page, **when** I request data, **I** get it from the daemon that owns it.

| ID | Criterion |
|---|---|
| c-AC-1 | Given a dashboard endpoint (for example `/api/memories`, `/api/graph`, `/api/diagnostics/*` per `honeycomb/src/dashboard/web/wire.ts:34-40` and `honeycomb/src/daemon/runtime/server.ts:73-107`), when a page requests it, then thehive's `wire` fetches from the owning daemon's `/api/*` base rather than a single same-origin. |
| c-AC-2 | Given hivenectar exposes `/api/source-graph/*`, when a page owned by hivenectar requests data, then thehive routes that request to hivenectar's base, distinct from honeycomb's. |

### US-2 - fail-soft aggregation

**As** an operator, **when** one daemon is down, **I** still see the rest of the dashboard.

| ID | Criterion |
|---|---|
| c-AC-3 | Given honeycomb's API is unreachable, when the dashboard loads, then honeycomb-owned panels render "unreachable"/empty while hivenectar-owned panels still render (fail-soft per daemon). |
| c-AC-4 | Given a malformed or partial response from a daemon, when `wire` parses it, then it degrades to the safe empty/zero state via the reused zod schemas rather than throwing into React (preserving honeycomb's `wire` posture at `honeycomb/src/dashboard/web/wire.ts`). |

### US-3 - no second data plane

**As** an architect, **when** I audit thehive, **I** find no Deep Lake client.

| ID | Criterion |
|---|---|
| c-AC-5 | Given thehive's implementation, when it is audited, then it holds no Deep Lake client, resolves no tenancy scope, and runs no queries; all data arrives over daemon `/api/*` (ADR-0004 decision #2). |

---

## Implementation notes

### Reuse the endpoint map + schemas, change the base

thehive's `wire` copies honeycomb's `ENDPOINTS` map (`honeycomb/src/dashboard/web/wire.ts:34-40`) and the per-endpoint zod schemas verbatim, because the wire truth (what each `/api/*` returns) is unchanged. What changes is the fetch base: honeycomb's `wire` uses one same-origin base; thehive's resolves a base **per endpoint** from a routing table keyed by owning daemon.

### The routing table is derived from hivedoctor's registry

Each registry entry ([`prd-001d`](./prd-001d-service-unit-and-registration.md)) carries a `healthUrl` whose host/port is where that daemon's `/api/*` also lives (honeycomb mounts `/health` and `/api/*` on the same host, `honeycomb/src/daemon/runtime/server.ts:73-107, 319-341`). thehive maps each endpoint to its owning daemon, then resolves that daemon's base from the registry. A daemon absent from the registry, or failing `/health`, yields the fail-soft unreachable result for its endpoints (c-AC-3). This is what lets a new workload daemon join the dashboard by exposing an API and registering, with no change to thehive's fetch base logic.

### Fail-soft per daemon

Aggregation isolates failures per daemon: a fetch error or a failed `/health` for one daemon returns that daemon's endpoints as empty/unreachable, never an exception that blanks the page. Combined with the reused zod parse (which already degrades malformed payloads to safe empty state, c-AC-4), the dashboard is resilient to any subset of daemons being down, which is the always-on property ([`prd-001a`](./prd-001a-thehive-process-and-bootstrap.md), ADR-0004 decision #1) carried through to the data layer.

### Open question (confirm before implementation)

The exact **endpoint-to-owner routing table** (which of honeycomb's `/api/*` groups map to honeycomb vs which future endpoints map to hivenectar) is derived from the registry at runtime, but the initial static mapping for the migrated pages should be confirmed against honeycomb's mounted groups (`honeycomb/src/daemon/runtime/server.ts:73-107`) and hivenectar's Source Graph API shape when that lands.

## Related

- [`prd-001b-dashboard-migration-and-copy-map.md`](./prd-001b-dashboard-migration-and-copy-map.md) - marks `wire.ts` as the one load-bearing modification this sub-PRD details.
- [`prd-001d-service-unit-and-registration.md`](./prd-001d-service-unit-and-registration.md) - the registry entries this routing table resolves daemon bases from.
- [hivenectar ADR-0004](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - decision #2 (API aggregation, not Deep Lake) this sub-PRD realizes.
- `honeycomb/src/dashboard/web/wire.ts:27, 34-40` - the ROI-type import and endpoint map the federated `wire` reuses.
- `honeycomb/src/daemon/runtime/server.ts:73-107, 319-341` - the `/api/*` groups and `/health` thehive aggregates.
