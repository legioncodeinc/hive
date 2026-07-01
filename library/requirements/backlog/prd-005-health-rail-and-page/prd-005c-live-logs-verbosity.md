# PRD-005c: Live logs with verbosity levels

> Parent: [`prd-005-health-rail-and-page-index.md`](./prd-005-health-rail-and-page-index.md)

## Overview

This sub-PRD delivers the live-logs section of the `/health` page: a tail of fleet log lines with selectable verbosity levels, streamed from hivedoctor over the SSE stream. Per the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), health data (including logs) arrives via the hivedoctor to thehive SSE stream (hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)), consumed through thehive's server per [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md).

Logs are the strictest test of the parent index's memory-bounding constraint: a naive tail accumulates unbounded history. This sub-PRD requires **windowed** consumption. The view holds a bounded window of recent lines and never the whole log history, in either the browser or thehive's server.

## Goals

- `/health` shows a live tail of fleet logs, updated from the SSE stream.
- The operator can select a verbosity level, and the view shows lines at or above that level.
- Changing verbosity updates the view without a page reload.
- The log view is bounded: a windowed buffer of recent lines, never the whole history in memory.

## Non-Goals

- Per-service metrics and Deep Lake stats - [`prd-005b`](./prd-005b-health-page-metrics.md).
- The health rail - [`prd-005a`](./prd-005a-health-rail.md).
- hivedoctor's log production, level tagging, or retention - hivedoctor [`ADR-0001`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md); this sub-PRD consumes the streamed lines and their levels.
- Full-text log search or long-range historical querying - out of scope for a bounded live tail; this view is the recent window, not an archive browser.

---

## User stories + acceptance criteria

### US-1 - live log tail over SSE

**As** an operator, **when** I open `/health`, **I** see recent fleet logs updating live.

| ID | Criterion |
|---|---|
| lg-AC-1 | Given `/health`, when it renders, then it shows a live tail of fleet log lines updated from the hivedoctor SSE stream, consumed through thehive's server (the browser never contacts hivedoctor directly). |
| lg-AC-2 | Given new log lines arrive on the stream, when they are received, then the tail appends them live within its bounded window, without a page reload. |
| lg-AC-3 | Given the SSE stream drops and reconnects, when it resumes, then the tail resumes appending without a manual refresh and without replaying the entire history. |

### US-2 - selectable verbosity

**As** an operator, **when** I adjust verbosity, **I** see more or fewer lines accordingly.

| ID | Criterion |
|---|---|
| lg-AC-4 | Given the log view, when it renders, then it exposes selectable verbosity levels, and the tail shows lines at or above the selected level. |
| lg-AC-5 | Given the operator changes the verbosity level, when the change applies, then the visible tail updates to the new level without reloading the page. |

### US-3 - bounded memory

**As** a performance reviewer, **when** I audit the log view, **I** find no unbounded buffering.

| ID | Criterion |
|---|---|
| lg-AC-6 | Given a long-lived log session, when it runs, then the view retains only a bounded window of recent lines; older lines fall out of the window rather than accumulating, so memory does not grow with time connected, in either the browser or thehive's server. |
| lg-AC-7 | Given verbosity is changed or the stream reconnects, when the view refills, then it queries a windowed view over the SSE stream rather than pulling whole log history into memory. |
| lg-AC-8 | Given a high log rate, when lines arrive faster than the window size, then the view keeps only the most recent window and remains responsive, never growing unboundedly to keep every line. |

---

## Implementation notes

### Windowed, not archival

The core discipline is that the log view is a bounded window over a stream, not a buffer of everything seen. Both the browser view and any thehive-side handling hold a fixed-size recent window (lg-AC-6); older lines are dropped from memory as new ones arrive. This directly satisfies the parent index's constraint that thehive never holds whole log history in memory, and it is why full-text search over all history is a non-goal here (that would require an archive this view deliberately does not keep).

### Verbosity is a filtered view of the same stream

Verbosity selection filters the streamed lines by level (lg-AC-4); it does not open a second stream or fetch history. Changing the level re-filters the current window and adjusts what subsequent lines are admitted (lg-AC-5, lg-AC-7), keeping a single SSE consumer consistent with [`prd-005a`](./prd-005a-health-rail.md)'s and [`prd-005b`](./prd-005b-health-page-metrics.md)'s shared stream discipline.

## Related

- [`prd-005-health-rail-and-page-index.md`](./prd-005-health-rail-and-page-index.md) - module scope and the memory-bounding constraint this sub-PRD stresses most.
- [`prd-005a-health-rail.md`](./prd-005a-health-rail.md) - the rail sharing the SSE consumption discipline.
- [`prd-005b-health-page-metrics.md`](./prd-005b-health-page-metrics.md) - the metrics section sharing the windowed approach.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - health (including logs) arrives over the SSE stream.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the proxy the log stream rides over; browser stays same-origin.
- hivedoctor [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the SSE stream and log source of truth.
- hivedoctor PRD-001 (telemetry transport + SSE), forthcoming under [`hivedoctor/library/requirements/backlog/`](../../../../../hivedoctor/library/requirements/backlog/) - the log-streaming contract this view consumes.
