# PRD-004: Buzzing readiness screen and service status loaders

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M
> **Schema changes:** None (hive renders doctor's registration + telemetry; it persists nothing new)
> **Implements:** [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) (the `/buzzing` readiness screen)

---

## Overview

PRD-004 delivers the `/buzzing` route's contents: the readiness screen an operator sees whenever the fleet is not yet healthy (the first branch of the gate precedence in [`prd-003`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md)). Per hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), `/buzzing` reads the service **registration** and per-service **health** from doctor and renders a per-service loading tile, so an operator watching a cold or degraded fleet sees exactly which service is not yet up.

The screen is the concrete successor to PRD-002's `ReadinessSplash`: [`prd-003c`](../prd-003-portal-landing-gate-and-routing/prd-003c-hash-to-path-migration.md) relocates that concept to the `/buzzing` route, and this PRD specifies what it renders. Two doctor surfaces feed it, both consumed through hive's server per [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md): the fleet-status projection (`GET /api/fleet-status`, PRD-002a) for the initial and fail-soft state, and the doctor to hive **SSE stream** (doctor [`ADR-0001`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)) for near-real-time per-service transitions. Which services should exist and their identities come from doctor's registry (doctor [`ADR-0002`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)).

---

## Features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-004a-buzzing-screen`](./prd-004a-buzzing-screen.md) | The `/buzzing` screen itself: reads registration + live health, renders one tile per registered service, and transitions to the app when the fleet is ready. The addressable successor to PRD-002's `ReadinessSplash` | Draft |
| [`prd-004b-bee-status-svg-set`](./prd-004b-bee-status-svg-set.md) | The bee-related status SVG icon set and the status state model: the enumerated states (error, degraded, starting, warming, active) and each state's visual mapping | Draft |
| [`prd-004c-status-derivation`](./prd-004c-status-derivation.md) | Status derivation from doctor telemetry: how each service's doctor-reported health maps to a loader state, consuming the fleet-status projection and the SSE stream | Draft |

---

## Goals

- `/buzzing` renders one loading tile per service that doctor's registry says should exist, keyed by the registered service identity.
- Each tile shows a bee-related status state that conveys, at minimum: error, degraded, starting, warming, active.
- Per-service state updates arrive near-real-time from the doctor SSE stream, with the fleet-status projection as the initial and fail-soft fallback.
- The screen dismisses into the app only when the fleet is ready (the same readiness rule the gate uses), echoing today's `ReadinessSplash` dismissal.
- A service becoming unreachable flips its own tile to error/degraded without blanking the screen or dropping the other tiles.

## Non-Goals

- The gate precedence and the `/buzzing` route's exemption - those are [`prd-003`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md); this PRD renders the screen that route serves.
- The always-present health rail and the `/health` page - those are [`prd-005`](../prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md); `/buzzing` is a transient pre-app screen, not the persistent rail.
- doctor's telemetry transport, registry schema, or the SSE producer side - doctor owns those (doctor [`ADR-0001`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md), [`ADR-0002`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)); this PRD consumes the contract.
- Final visual design polish of the bee art (motion, exact palette) beyond the required state-to-visual mapping - an implementation-time `ux-ui-worker-bee` concern; this PRD locks the state set and its semantics.

---

## Status state model (locked)

Every service tile is in exactly one of these states. [`prd-004b`](./prd-004b-bee-status-svg-set.md) owns the SVG for each; [`prd-004c`](./prd-004c-status-derivation.md) owns the derivation from doctor telemetry.

| State | Meaning |
|---|---|
| `error` | The service is registered but doctor reports it failed or unreachable (not expected to recover without intervention). |
| `degraded` | The service is up but doctor reports it unhealthy or partially functional. |
| `starting` | The service is registered and has begun its process lifecycle but has not yet bound or checked in. |
| `warming` | The service has checked in but is not yet reporting healthy (initializing, loading, or warming caches). |
| `active` | The service is registered, checked in, and doctor reports it healthy. |

---

## Module acceptance criteria

- [ ] `/buzzing` renders exactly one tile per service in doctor's registration set; a registered service with no runtime status yet still gets a tile (in `starting`), never an omitted row ([`prd-004a`](./prd-004a-buzzing-screen.md), [`prd-004c`](./prd-004c-status-derivation.md)).
- [ ] Each of the five states (`error`, `degraded`, `starting`, `warming`, `active`) renders its corresponding bee-related status SVG ([`prd-004b`](./prd-004b-bee-status-svg-set.md)).
- [ ] Per-service state transitions arrive over the doctor SSE stream and update the relevant tile in near-real-time without a full-screen reload ([`prd-004c`](./prd-004c-status-derivation.md)).
- [ ] With the SSE stream unavailable, `/buzzing` falls back to the `GET /api/fleet-status` projection (PRD-002a) for tile state rather than blanking ([`prd-004a`](./prd-004a-buzzing-screen.md), [`prd-004c`](./prd-004c-status-derivation.md)).
- [ ] A service going unreachable flips only its own tile to `error` or `degraded`; the other tiles and the screen itself are unaffected (no blank screen, no dropped tiles) ([`prd-004a`](./prd-004a-buzzing-screen.md), [`prd-004c`](./prd-004c-status-derivation.md)).
- [ ] When the fleet becomes ready (the same readiness rule the gate applies), `/buzzing` transitions to the app, echoing today's `ReadinessSplash` dismissal ([`prd-004a`](./prd-004a-buzzing-screen.md)).
- [ ] Each doctor-reported service condition maps deterministically to exactly one of the five states, with the mapping defined once and shared ([`prd-004c`](./prd-004c-status-derivation.md)).

---

## Overlap and supersession

- This PRD is the rendering half of the readiness experience honeycomb [`prd-070-first-browser-load-experience`](../../../../../honeycomb/library/requirements/archive/prd-070-first-browser-load-experience/prd-070-first-browser-load-experience-index.md) scoped; that PRD is superseded by ADR-0004, and the first-browser-load readiness screen is hive's `/buzzing`.
- It also supersedes the boot-shell readiness surface honeycomb [`prd-068-portal-daemon-boot-shell`](../../../../../honeycomb/library/requirements/archive/prd-068-portal-daemon-boot-shell/prd-068-portal-daemon-boot-shell-index.md) implied, now that hive is the always-on origin.
- It supersedes the read-only per-service status portion of honeycomb [`prd-069-application-health-dashboard`](../../../../../honeycomb/library/requirements/archive/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) and honeycomb [`prd-054-fleet-observation-control-plane`](../../../../../honeycomb/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md) for the readiness view; the persistent health surface is [`prd-005`](../prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md).
- It refines PRD-002: the `ReadinessSplash` becomes `/buzzing`, and the coarse readiness gate gains a per-service tile grid.

---

## Related

- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - defines `/buzzing` as the readiness screen that reads registration + per-service health from doctor.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the proxy the fleet-status projection and SSE stream ride over.
- [`ADR-0003-future-sse-streaming-for-dashboard-freshness`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) - the SSE pattern this screen consumes for live transitions.
- doctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the telemetry source and the single SSE stream feeding live per-service state.
- doctor [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the registration set that determines which tiles exist.
- hive [`prd-003-portal-landing-gate-and-routing`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) - the gate that routes an unhealthy fleet to `/buzzing`.
- hive [`prd-005-health-rail-and-page`](../prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md) - the persistent health rail and page (distinct from this transient screen).
- hive [`prd-002-portal-readiness-splash`](../../in-work/prd-002-portal-readiness-splash/prd-002-portal-readiness-splash-index.md) - the `ReadinessSplash` this screen succeeds.
- hive [`prd-002a-fleet-status-proxy`](../../in-work/prd-002-portal-readiness-splash/prd-002a-fleet-status-proxy.md) - the `GET /api/fleet-status` projection used as the fail-soft fallback.
- doctor PRD-001 (telemetry transport + SSE) and PRD-002 (service registration), forthcoming under [`doctor/library/requirements/backlog/`](../../../../../doctor/library/requirements/backlog/) - the implementations of the doctor ADRs above.
- Superseded: honeycomb [`prd-068-portal-daemon-boot-shell`](../../../../../honeycomb/library/requirements/archive/prd-068-portal-daemon-boot-shell/prd-068-portal-daemon-boot-shell-index.md), honeycomb [`prd-070-first-browser-load-experience`](../../../../../honeycomb/library/requirements/archive/prd-070-first-browser-load-experience/prd-070-first-browser-load-experience-index.md); read-only status portion of honeycomb [`prd-069-application-health-dashboard`](../../../../../honeycomb/library/requirements/archive/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) and honeycomb [`prd-054-fleet-observation-control-plane`](../../../../../honeycomb/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md).
