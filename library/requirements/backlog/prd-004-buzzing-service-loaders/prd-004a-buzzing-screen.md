# PRD-004a: The `/buzzing` readiness screen

> Parent: [`prd-004-buzzing-service-loaders-index.md`](./prd-004-buzzing-service-loaders-index.md)

## Overview

This sub-PRD delivers the `/buzzing` screen: the per-service loading grid an operator sees whenever the gate ([`prd-003`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md)) routes them there because the fleet is not yet healthy. Per the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), it reads the service registration and per-service health from hivedoctor and renders one tile per registered service, so the operator sees exactly which service is not up.

It is the addressable successor to PRD-002's `ReadinessSplash` (`the-hive/src/dashboard/web`), relocated to the `/buzzing` route by [`prd-003c`](../prd-003-portal-landing-gate-and-routing/prd-003c-hash-to-path-migration.md). This sub-PRD owns the screen's structure and lifecycle; the SVG per state is [`prd-004b`](./prd-004b-bee-status-svg-set.md) and the telemetry-to-state derivation is [`prd-004c`](./prd-004c-status-derivation.md).

## Goals

- Render one tile per service in hivedoctor's registration set, keyed by registered service identity.
- Show each tile's current status state (from [`prd-004c`](./prd-004c-status-derivation.md)) using the matching bee SVG (from [`prd-004b`](./prd-004b-bee-status-svg-set.md)).
- Update tiles in near-real-time from the hivedoctor SSE stream, falling back to the fleet-status projection when the stream is unavailable.
- Transition to the app when the fleet becomes ready, echoing today's `ReadinessSplash` dismissal.
- Never blank the screen or drop tiles when a single service degrades or disappears.

## Non-Goals

- The bee SVG art and the visual mapping of each state - [`prd-004b`](./prd-004b-bee-status-svg-set.md).
- The rule that maps hivedoctor telemetry to one of the five states - [`prd-004c`](./prd-004c-status-derivation.md).
- The gate that routes here and the `/buzzing` exemption - [`prd-003`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md).
- The persistent health rail and `/health` page - [`prd-005`](../prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md).

---

## User stories + acceptance criteria

### US-1 - one tile per registered service

**As** an operator on a cold or degraded fleet, **when** I see `/buzzing`, **I** see a tile for every service that should exist.

| ID | Criterion |
|---|---|
| bz-AC-1 | Given hivedoctor's registration set, when `/buzzing` renders, then it shows exactly one tile per registered service, keyed by the registered service identity, with no registered service omitted. |
| bz-AC-2 | Given a registered service with no runtime status reported yet, when `/buzzing` renders, then that service still gets a tile (in `starting`, per [`prd-004c`](./prd-004c-status-derivation.md)) rather than being absent. |
| bz-AC-3 | Given each tile, when it renders, then it displays the service's current status state via the corresponding bee SVG ([`prd-004b`](./prd-004b-bee-status-svg-set.md)). |

### US-2 - live updates with fail-soft fallback

**As** an operator, **when** services change state, **I** see tiles update without reloading the screen.

| ID | Criterion |
|---|---|
| bz-AC-4 | Given the hivedoctor SSE stream is connected, when a service's state changes, then only the affected tile updates, in near-real-time, without a full-screen reload. |
| bz-AC-5 | Given the SSE stream is unavailable or drops, when `/buzzing` needs tile state, then it falls back to the `GET /api/fleet-status` projection (PRD-002a) and continues rendering tiles rather than blanking. |
| bz-AC-6 | Given the SSE stream reconnects after a drop, when it resumes, then the screen resumes live updates without a manual refresh. |

### US-3 - single-service degradation is isolated

**As** an operator, **when** one service dies, **I** still see the rest of the fleet.

| ID | Criterion |
|---|---|
| bz-AC-7 | Given a service becomes unreachable, when its state flips to `error` or `degraded` ([`prd-004c`](./prd-004c-status-derivation.md)), then only that tile changes; the screen does not blank and no other tile is dropped. |
| bz-AC-8 | Given a partially healthy fleet, when some tiles are `active` and others are not, then all tiles remain visible so the operator can see precisely which services are blocking readiness. |

### US-4 - dismissal on readiness

**As** an operator, **when** the fleet becomes ready, **I** am taken into the app automatically.

| ID | Criterion |
|---|---|
| bz-AC-9 | Given the fleet becomes ready (the same readiness rule the gate applies, reusing PRD-002a's `isFleetReady()`), when `/buzzing` observes it, then the screen transitions into the app, echoing today's `ReadinessSplash` dismissal. |
| bz-AC-10 | Given the fleet is not yet ready, when `/buzzing` is shown, then it persists (never falls through to the dashboard or `/login`) because `/buzzing` is gate-exempt and dismissal is readiness-driven. |

---

## Implementation notes

### Successor to `ReadinessSplash`

`/buzzing` is the concept PRD-002's `ReadinessSplash` established, now a route rather than a pre-mount gate. It keeps the readiness-driven dismissal (reusing `isFleetReady()` from PRD-002a so "ready" means the same thing on the screen and the gate) and adds the per-service tile grid ADR-0004 calls for. The relocation of the mount point is owned by [`prd-003c`](../prd-003-portal-landing-gate-and-routing/prd-003c-hash-to-path-migration.md); this sub-PRD owns what renders once it is there.

### Two sources, one view-model

Tiles render from a single view-model fed preferentially by the SSE stream (live) and, when the stream is down, by the fleet-status projection (fail-soft). Both are consumed through thehive's server per [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md); the browser never contacts hivedoctor directly. The derivation from either source into the five states is [`prd-004c`](./prd-004c-status-derivation.md).

## Related

- [`prd-004-buzzing-service-loaders-index.md`](./prd-004-buzzing-service-loaders-index.md) - module scope and the locked state model.
- [`prd-004b-bee-status-svg-set.md`](./prd-004b-bee-status-svg-set.md) - the SVG each tile state renders.
- [`prd-004c-status-derivation.md`](./prd-004c-status-derivation.md) - how each tile's state is derived from hivedoctor telemetry.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - `/buzzing` reads registration + per-service health and renders per-service loading state.
- hivedoctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the SSE stream feeding live tile updates.
- the-hive [`prd-003c-hash-to-path-migration`](../prd-003-portal-landing-gate-and-routing/prd-003c-hash-to-path-migration.md) - relocates `ReadinessSplash` to this route.
- the-hive [`prd-002a-fleet-status-proxy`](../../in-work/prd-002-portal-readiness-splash/prd-002a-fleet-status-proxy.md) - `GET /api/fleet-status` and `isFleetReady()` reused here.
- the-hive [`prd-002b-readiness-splash-ui`](../../in-work/prd-002-portal-readiness-splash/prd-002b-readiness-splash-ui.md) - the `ReadinessSplash` component this screen succeeds.
