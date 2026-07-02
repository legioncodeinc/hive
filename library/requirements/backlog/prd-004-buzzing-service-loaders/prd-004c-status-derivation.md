# PRD-004c: Status derivation from doctor telemetry

> Parent: [`prd-004-buzzing-service-loaders-index.md`](./prd-004-buzzing-service-loaders-index.md)

## Overview

This sub-PRD owns the rule that maps doctor's per-service telemetry to exactly one of the five loader states (`error`, `degraded`, `starting`, `warming`, `active`) that [`prd-004a`](./prd-004a-buzzing-screen.md) renders and [`prd-004b`](./prd-004b-bee-status-svg-set.md) draws. It is the seam between doctor's supervision truth and the readiness screen's view-model.

Per doctor [`ADR-0001`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md), doctor is the single source of truth for service state: services write local SQLite, doctor polls them roughly every second plus a `/health` check, and it maintains one SSE stream to hive. Per doctor [`ADR-0002`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md), each service has a static registry entry (it should exist, plus its SQLite db path) merged with runtime SQLite status (check-in, binding time, last-seen, health, metrics). This sub-PRD derives a loader state from that merged registration-plus-runtime signal, consuming it through hive's server via the SSE stream (live) and the `GET /api/fleet-status` projection (fail-soft), never by contacting doctor directly.

## Goals

- A single, shared derivation from doctor's merged registration + runtime signal to one of the five states.
- The derivation distinguishes lifecycle phases doctor exposes: registered-but-not-checked-in (`starting`), checked-in-but-not-healthy (`warming`), and healthy (`active`), plus unhealthy (`degraded`) and failed/unreachable (`error`).
- The same derivation runs whether the input arrives from the SSE stream or the fleet-status projection, so state does not change meaning across sources.
- A registered service with no runtime row yet derives to `starting`, never to an omitted tile or a false `active`.

## Non-Goals

- The SVG per state - [`prd-004b`](./prd-004b-bee-status-svg-set.md).
- The screen and tile lifecycle - [`prd-004a`](./prd-004a-buzzing-screen.md).
- doctor's telemetry production, polling, or registry merge - doctor owns those (doctor [`ADR-0001`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md), [`ADR-0002`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)); this sub-PRD consumes the merged signal.
- The `isFleetReady()` fleet-level readiness rule that drives dismissal - that is PRD-002a, reused by [`prd-004a`](./prd-004a-buzzing-screen.md); this sub-PRD derives per-service state, not the fleet-ready boolean.

---

## Derivation model (locked)

Each service's loader state is derived from its merged registration + runtime signal:

| doctor signal for a service | Derived loader state |
|---|---|
| Registered, but no runtime check-in yet (no runtime row / not yet bound) | `starting` |
| Registered, checked in, but not yet reporting healthy (initializing / warming) | `warming` |
| Registered, checked in, health reported healthy | `active` |
| Registered, up, but health reported unhealthy or partial | `degraded` |
| Registered, but failed or unreachable (process down, last-seen stale beyond threshold, or doctor reports it unreachable) | `error` |

The precise health enum values and thresholds are doctor's (doctor PRD-001 / PRD-002); this table is the mapping hive applies to whatever doctor reports.

---

## User stories + acceptance criteria

### US-1 - deterministic per-service derivation

**As** a tile, **when** doctor reports my service, **I** show exactly one derived state.

| ID | Criterion |
|---|---|
| sd-AC-1 | Given a service's merged registration + runtime signal from doctor, when the derivation runs, then it produces exactly one of the five states (`error`, `degraded`, `starting`, `warming`, `active`) per the derivation table. |
| sd-AC-2 | Given a registered service with no runtime check-in yet, when the derivation runs, then it yields `starting` (never an omitted tile, never `active`). |
| sd-AC-3 | Given a service reported failed, process-down, or with a stale last-seen beyond doctor's threshold, when the derivation runs, then it yields `error`. |
| sd-AC-4 | Given a service reported up but unhealthy or partial, when the derivation runs, then it yields `degraded`. |
| sd-AC-5 | Given a service checked in but not yet healthy, when the derivation runs, then it yields `warming`; given it is healthy, it yields `active`. |

### US-2 - source-independent derivation

**As** a maintainer, **when** the input source changes, **I** get the same derived state.

| ID | Criterion |
|---|---|
| sd-AC-6 | Given the same underlying service condition, when the input arrives via the SSE stream versus the `GET /api/fleet-status` projection, then the derivation yields the identical state (the rule is single-sourced and source-agnostic). |
| sd-AC-7 | Given the SSE stream drops and the projection takes over, when a service is re-derived, then its tile state does not spuriously change unless the underlying doctor signal changed. |

### US-3 - isolated per-service updates

**As** an operator, **when** one service changes, **I** see only its tile re-derive.

| ID | Criterion |
|---|---|
| sd-AC-8 | Given a per-service update over the SSE stream, when it is applied, then only the affected service is re-derived; other services' derived states are untouched. |
| sd-AC-9 | Given a service that becomes unreachable, when it is re-derived, then its state flips to `error` (or `degraded` per the table) without altering any other service's state, supporting [`prd-004a`](./prd-004a-buzzing-screen.md)'s no-blank-screen guarantee (bz-AC-7). |

---

## Implementation notes

### One rule, two feeds

The derivation is a pure function from a service's merged doctor signal to a loader state, imported by both the SSE-fed live path and the projection-fed fail-soft path in [`prd-004a`](./prd-004a-buzzing-screen.md). Keeping it pure and single-sourced (sd-AC-6) means readiness state cannot drift between live and fallback rendering, and the rule is unit-testable without a live doctor, mirroring how PRD-002a keeps `isFleetReady()` pure.

### Registration-plus-runtime, not health alone

Because doctor merges a static registry entry with runtime SQLite status (doctor [`ADR-0002`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)), a service can be "known to exist" before it has any runtime row. The derivation treats that as `starting` (sd-AC-2), which is what lets [`prd-004a`](./prd-004a-buzzing-screen.md) show a tile for every registered service (bz-AC-1/bz-AC-2) even on a cold fleet.

## Related

- [`prd-004-buzzing-service-loaders-index.md`](./prd-004-buzzing-service-loaders-index.md) - the locked state model this derivation targets.
- [`prd-004a-buzzing-screen.md`](./prd-004a-buzzing-screen.md) - the screen that consumes derived states per tile.
- [`prd-004b-bee-status-svg-set.md`](./prd-004b-bee-status-svg-set.md) - the SVG for each derived state.
- doctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the telemetry, polling, and single SSE stream this derivation reads.
- doctor [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the static registry + runtime SQLite merge the derivation interprets.
- hive [`prd-002a-fleet-status-proxy`](../../in-work/prd-002-portal-readiness-splash/prd-002a-fleet-status-proxy.md) - the projection used as the fail-soft feed and the pure-predicate precedent.
- doctor PRD-001 (telemetry transport + SSE) and PRD-002 (service registration), forthcoming under [`doctor/library/requirements/backlog/`](../../../../../doctor/library/requirements/backlog/) - the source of the health enum and thresholds this table maps.
