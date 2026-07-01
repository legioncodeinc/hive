# PRD-005b: `/health` page metrics and Deep Lake stats

> Parent: [`prd-005-health-rail-and-page-index.md`](./prd-005-health-rail-and-page-index.md)

## Overview

This sub-PRD delivers the metric content of the `/health` page: per-service counters since last restart and the Deep Lake connection state and stats. Per the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), these consume the hivedoctor to thehive SSE stream (hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)), through thehive's server per [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md).

The counters are the operator-facing "what has the fleet done since it came up" view: actions taken, files processed, and memories created, per service, since last restart. The Deep Lake block answers "is our storage reachable and when did we last talk to it." A hard constraint from the parent index applies: consumption is windowed over the SSE stream; thehive never buffers an unbounded metric series in memory.

## Goals

- `/health` shows, per service, the counts since last restart: actions taken, files processed, memories created.
- `/health` shows the Deep Lake connection state and stats, including the last time the fleet communicated with Deep Lake.
- Metrics update live from the SSE stream and reflect the current since-restart totals hivedoctor reports.
- Metric consumption is bounded: current totals and a windowed view, never an unbounded accumulation in the browser or thehive's server.

## Non-Goals

- The health rail - [`prd-005a`](./prd-005a-health-rail.md).
- Live logs and verbosity - [`prd-005c`](./prd-005c-live-logs-verbosity.md).
- How hivedoctor collects or resets the counters (the "since last restart" boundary is hivedoctor's telemetry semantic) - hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) / hivedoctor [`ADR-0002`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md); this sub-PRD renders what it reports.
- thehive holding a Deep Lake client - it does not; the Deep Lake stats come from hivedoctor telemetry about the workload daemons' connections.

---

## User stories + acceptance criteria

### US-1 - per-service counters since last restart

**As** an operator, **when** I open `/health`, **I** see what each service has done since it came up.

| ID | Criterion |
|---|---|
| hm-AC-1 | Given `/health`, when it renders, then it shows, per service, the count of actions taken since last restart. |
| hm-AC-2 | Given `/health`, when it renders, then it shows, per service, the count of files processed since last restart. |
| hm-AC-3 | Given `/health`, when it renders, then it shows, per service, the count of memories created since last restart. |
| hm-AC-4 | Given a service restarts, when its counters reset in hivedoctor telemetry, then `/health` reflects the reset totals rather than continuing a stale pre-restart count. |

### US-2 - Deep Lake connection and stats

**As** an operator, **when** I open `/health`, **I** see whether storage is reachable and when we last used it.

| ID | Criterion |
|---|---|
| hm-AC-5 | Given `/health`, when it renders, then it shows the Deep Lake connection state (for example reachable / unreachable) as reported through hivedoctor telemetry. |
| hm-AC-6 | Given `/health`, when it renders, then it shows Deep Lake stats including the last time the fleet communicated with Deep Lake. |
| hm-AC-7 | Given Deep Lake becomes unreachable, when telemetry reports it, then `/health` reflects the changed connection state live rather than showing a stale "connected." |

### US-3 - live and bounded

**As** a performance reviewer, **when** I audit `/health`, **I** find live metrics without unbounded memory.

| ID | Criterion |
|---|---|
| hm-AC-8 | Given the SSE stream, when metrics change, then `/health` updates the affected counters and Deep Lake stats live, consumed through thehive's server (the browser never contacts hivedoctor directly). |
| hm-AC-9 | Given a long-lived `/health` session, when it runs, then metric consumption is windowed: thehive and the browser retain current totals and a bounded window, never an unbounded metric series accumulated in memory. |
| hm-AC-10 | Given the SSE stream is unavailable, when `/health` loads, then it renders the last known metrics or a clear "telemetry unavailable" state rather than a broken page. |

---

## Implementation notes

### Render, do not own, the numbers

thehive holds no Deep Lake client and does not count anything itself; every counter and the Deep Lake stats originate in hivedoctor telemetry (the workload daemons write local SQLite, hivedoctor aggregates, per hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)). The "since last restart" boundary and any reset semantics are hivedoctor's; `/health` renders the reported totals (hm-AC-4). This keeps the single-source-of-truth posture intact.

### Bounded by construction

Counters are current totals, not a growing client-side log, so they are naturally bounded. The Deep Lake "last communicated" stat is a single timestamp, not a series. Any time-series presentation stays within a fixed window over the SSE stream (hm-AC-9), consistent with the parent index's memory constraint and shared with [`prd-005c`](./prd-005c-live-logs-verbosity.md)'s windowing discipline.

## Related

- [`prd-005-health-rail-and-page-index.md`](./prd-005-health-rail-and-page-index.md) - module scope, the metric list, and the memory-bounding constraint.
- [`prd-005a-health-rail.md`](./prd-005a-health-rail.md) - the rail that links to this page.
- [`prd-005c-live-logs-verbosity.md`](./prd-005c-live-logs-verbosity.md) - the logs view sharing the windowed SSE discipline.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the health view-model consuming the SSE stream.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the proxy the SSE stream and metrics ride over.
- hivedoctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the telemetry source of the counters and Deep Lake stats.
- hivedoctor [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the runtime metrics per registered service.
- hivedoctor PRD-001 (telemetry transport + SSE) and PRD-002 (service registration), forthcoming under [`hivedoctor/library/requirements/backlog/`](../../../../../hivedoctor/library/requirements/backlog/) - the metric and SSE contracts rendered here.
