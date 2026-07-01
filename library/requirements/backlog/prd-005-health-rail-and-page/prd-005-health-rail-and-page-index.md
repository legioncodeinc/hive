# PRD-005: Health rail and health page

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Schema changes:** None (thehive renders hivedoctor's SSE telemetry; it holds no Deep Lake client and persists nothing new)
> **Implements:** [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) (the health view-model as the first concrete SSE-through-proxy consumer)

---

## Overview

PRD-005 delivers thehive's persistent health surface: a top **health rail** of per-service pills present on every page, and a dedicated **`/health` route** that renders per-service metrics, live logs, and Deep Lake connection stats. Per the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), near-real-time health arrives via the hivedoctor to thehive **SSE stream** rather than an interval poll; the health rail is the first concrete SSE-through-proxy consumer beyond the existing Logs tail, realizing the direction [`ADR-0003`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) proposed.

The rail and page source their truth from hivedoctor, the single source of truth for fleet telemetry (hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)): services write local SQLite, hivedoctor polls them and maintains one SSE stream to thehive. thehive consumes that stream through its server per [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md); the browser is same-origin to thehive and never contacts hivedoctor directly.

A hard constraint threads through all three sub-PRDs: **memory must stay bounded**. The health page consumes windowed views over the SSE stream and never holds whole log history or unbounded metric series in memory.

---

## Features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-005a-health-rail`](./prd-005a-health-rail.md) | The top health rail of per-service pills, present on every route, fed by the hivedoctor SSE stream (with the fleet-status projection as fail-soft) | Draft |
| [`prd-005b-health-page-metrics`](./prd-005b-health-page-metrics.md) | The `/health` page's per-service metrics since last restart (actions taken, files processed, memories created) plus the Deep Lake connection and stats (including last communication time), consuming the SSE stream | Draft |
| [`prd-005c-live-logs-verbosity`](./prd-005c-live-logs-verbosity.md) | Live logs on `/health` with selectable verbosity levels, bounded and windowed over the SSE stream so memory never grows with history | Draft |

---

## Goals

- A health rail of per-service pills renders on every route, each pill showing the service's current status, fed live by the hivedoctor SSE stream.
- `/health` renders per-service metrics counted since last restart: actions taken, files processed, memories created.
- `/health` renders the Deep Lake connection state and stats, including the last time thehive's fleet communicated with Deep Lake.
- `/health` renders live logs with selectable verbosity levels.
- All health consumption is windowed over the SSE stream; thehive never holds whole log history or unbounded series in memory.

## Non-Goals

- The gate precedence and whether `/health` is gated - that is [`prd-003`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md); this PRD renders the rail and the page within whatever route model the gate serves.
- The transient `/buzzing` readiness screen and its per-service tiles - that is [`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md); the rail and `/health` are the persistent health surface, distinct from the pre-app readiness screen.
- hivedoctor's telemetry production, SSE producer, metric collection, or registry - hivedoctor owns those (hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md), [`ADR-0002`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)); this PRD consumes the SSE contract.
- Deep Lake itself and how workload daemons connect to it - honeycomb and hivenectar own their Deep Lake clients; thehive renders the connection stats hivedoctor telemetry surfaces.

---

## Module acceptance criteria

- [ ] A health rail of per-service pills is present on every route, each pill reflecting the service's current status, updated live from the hivedoctor SSE stream ([`prd-005a`](./prd-005a-health-rail.md)).
- [ ] With the SSE stream unavailable, the rail falls back to the `GET /api/fleet-status` projection (PRD-002a) and continues rendering pills rather than disappearing ([`prd-005a`](./prd-005a-health-rail.md)).
- [ ] `/health` shows, per service, the counts since last restart: actions taken, files processed, and memories created ([`prd-005b`](./prd-005b-health-page-metrics.md)).
- [ ] `/health` shows the Deep Lake connection state and stats, including the last time the fleet communicated with Deep Lake ([`prd-005b`](./prd-005b-health-page-metrics.md)).
- [ ] `/health` shows live logs with selectable verbosity levels, and changing verbosity changes what is shown without reloading the page ([`prd-005c`](./prd-005c-live-logs-verbosity.md)).
- [ ] Log and metric consumption is windowed over the SSE stream; thehive never buffers whole log history or an unbounded metric series in memory ([`prd-005b`](./prd-005b-health-page-metrics.md), [`prd-005c`](./prd-005c-live-logs-verbosity.md)).
- [ ] The rail and page consume the SSE stream through thehive's server; the browser never opens a direct connection to hivedoctor ([`prd-005a`](./prd-005a-health-rail.md), [`prd-005b`](./prd-005b-health-page-metrics.md), [`prd-005c`](./prd-005c-live-logs-verbosity.md)).

---

## Overlap and supersession

- This PRD supersedes the read-only application-health surface honeycomb [`prd-069-application-health-dashboard`](../../../../../honeycomb/library/requirements/backlog/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) scoped and the read-only observation portion of honeycomb [`prd-054-fleet-observation-control-plane`](../../../../../honeycomb/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md): the persistent health rail and health page live in thehive now that it is the always-on single origin (ADR-0001, ADR-0002). Any control-plane action surface beyond read-only observation is out of scope here.
- It complements [`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md): `/buzzing` is the transient pre-app readiness screen; the rail and `/health` are the always-present, in-app health surface. Both consume the same hivedoctor SSE stream and may share the status vocabulary from [`prd-004b`](../prd-004-buzzing-service-loaders/prd-004b-bee-status-svg-set.md).

---

## Related

- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - makes the health view-model the first concrete SSE-through-proxy consumer and names the health rail's live source.
- [`ADR-0003-future-sse-streaming-for-dashboard-freshness`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) - the SSE-over-proxy pattern this PRD realizes for health.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the proxy the SSE stream rides over; the browser stays same-origin to thehive.
- hivedoctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the single source of truth and the one SSE stream feeding the rail, metrics, and logs.
- hivedoctor [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the registration + runtime metrics the page renders per service.
- the-hive [`prd-003-portal-landing-gate-and-routing`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) - the route model the rail renders across and `/health` is served under.
- the-hive [`prd-004-buzzing-service-loaders`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) - the transient readiness screen this persistent surface complements.
- the-hive [`prd-001-thehive-portal-daemon`](../../in-work/prd-001-thehive-portal-daemon/prd-001-thehive-portal-daemon-index.md) - the portal daemon and BFF proxy the rail and page render inside.
- the-hive [`prd-002-portal-readiness-splash`](../../in-work/prd-002-portal-readiness-splash/prd-002-portal-readiness-splash-index.md) - the fleet-status projection reused as the rail's fail-soft fallback.
- hivedoctor PRD-001 (telemetry transport + SSE) and PRD-002 (service registration), forthcoming under [`hivedoctor/library/requirements/backlog/`](../../../../../hivedoctor/library/requirements/backlog/) - the SSE and metric contracts this PRD consumes.
- Superseded: read-only portions of honeycomb [`prd-069-application-health-dashboard`](../../../../../honeycomb/library/requirements/backlog/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) and honeycomb [`prd-054-fleet-observation-control-plane`](../../../../../honeycomb/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md).
