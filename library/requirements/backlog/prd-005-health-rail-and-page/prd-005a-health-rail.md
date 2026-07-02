# PRD-005a: Top health rail

> Parent: [`prd-005-health-rail-and-page-index.md`](./prd-005-health-rail-and-page-index.md)

## Overview

This sub-PRD delivers the top health rail: a strip of per-service status pills present on every route of hive's dashboard, giving an operator constant fleet awareness without leaving their current page. Per hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), the rail's live source is the doctor to hive SSE stream (the first concrete SSE-through-proxy consumer beyond the Logs tail), with the `GET /api/fleet-status` projection (PRD-002a) as the fail-soft fallback.

The rail is the persistent, in-app counterpart to the transient `/buzzing` tiles ([`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md)): once the operator is in the app, the rail is how they keep seeing fleet health. It may reuse the status vocabulary from [`prd-004b`](../prd-004-buzzing-service-loaders/prd-004b-bee-status-svg-set.md) so one visual language spans readiness and steady state.

## Goals

- A rail of one pill per service renders on every route, each pill showing the service's current status.
- The rail updates live from the doctor SSE stream, consumed through hive's server.
- The rail falls back to the fleet-status projection when the SSE stream is unavailable, never disappearing.
- The rail reuses the single status vocabulary so a state means the same thing on the rail as on `/buzzing`.

## Non-Goals

- The `/health` page's metrics, Deep Lake stats, and logs - [`prd-005b`](./prd-005b-health-page-metrics.md) and [`prd-005c`](./prd-005c-live-logs-verbosity.md).
- The status state model and SVG set - owned by [`prd-004b`](../prd-004-buzzing-service-loaders/prd-004b-bee-status-svg-set.md); the rail reuses it.
- The SSE producer and telemetry - doctor's (doctor [`ADR-0001`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)).
- Whether any route is gated - [`prd-003`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md); the rail renders on the in-app routes the gate serves.

---

## User stories + acceptance criteria

### US-1 - present on every route

**As** an operator, **when** I move around the dashboard, **I** always see fleet health.

| ID | Criterion |
|---|---|
| hr-AC-1 | Given any in-app route, when it renders, then the top health rail is present with one pill per service in doctor's registration set. |
| hr-AC-2 | Given a pill, when it renders, then it shows the service's current status using the shared status vocabulary ([`prd-004b`](../prd-004-buzzing-service-loaders/prd-004b-bee-status-svg-set.md)). |

### US-2 - live via SSE, fail-soft via projection

**As** an operator, **when** a service changes state, **I** see its pill update without reloading.

| ID | Criterion |
|---|---|
| hr-AC-3 | Given the doctor SSE stream is connected, when a service's state changes, then its pill updates in near-real-time without a page reload, sourced from the stream consumed through hive's server. |
| hr-AC-4 | Given the SSE stream is unavailable or drops, when the rail needs state, then it falls back to the `GET /api/fleet-status` projection (PRD-002a) and keeps rendering pills rather than disappearing. |
| hr-AC-5 | Given the SSE stream reconnects, when it resumes, then the rail resumes live updates without a manual refresh. |

### US-3 - same-origin, bounded

**As** a security and performance reviewer, **when** I audit the rail, **I** find no direct doctor connection and no unbounded buffering.

| ID | Criterion |
|---|---|
| hr-AC-6 | Given the rail's data path, when audited, then the browser consumes the SSE stream and the projection through hive's own origin only; it never opens a direct connection to doctor's `:3852`. |
| hr-AC-7 | Given the rail consumes a long-lived stream, when it runs, then it retains only current per-service state (not stream history), so memory does not grow with time connected. |

---

## Implementation notes

### First SSE-through-proxy consumer

Per ADR-0004, the rail is the first concrete consumer of the doctor to hive SSE stream beyond the Logs tail. It rides the proxy from [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) with explicit reconnect and the projection fallback, the added moving part ADR-0003 anticipated. Keeping the browser same-origin (hr-AC-6) preserves hive's credential-free, no-cross-origin posture.

### Shared vocabulary with `/buzzing`

Reusing the status state set and SVGs from [`prd-004b`](../prd-004-buzzing-service-loaders/prd-004b-bee-status-svg-set.md) means an operator who learned the readiness screen's states reads the rail with no new vocabulary. The rail holds only current state per service (hr-AC-7), consistent with the parent index's memory-bounding constraint.

## Related

- [`prd-005-health-rail-and-page-index.md`](./prd-005-health-rail-and-page-index.md) - module scope and the SSE source.
- [`prd-005b-health-page-metrics.md`](./prd-005b-health-page-metrics.md) - the `/health` page the rail links operators toward.
- [`prd-005c-live-logs-verbosity.md`](./prd-005c-live-logs-verbosity.md) - the logs view that shares the SSE consumption discipline.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - names the rail as the first SSE-through-proxy consumer and its live source.
- [`ADR-0003-future-sse-streaming-for-dashboard-freshness`](../../../knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) - the SSE pattern with reconnect and fallback.
- doctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the single SSE stream feeding the rail.
- hive [`prd-004b-bee-status-svg-set`](../prd-004-buzzing-service-loaders/prd-004b-bee-status-svg-set.md) - the shared status vocabulary the pills reuse.
- hive [`prd-002a-fleet-status-proxy`](../../in-work/prd-002-portal-readiness-splash/prd-002a-fleet-status-proxy.md) - the projection the rail falls back to.
