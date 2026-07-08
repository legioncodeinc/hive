# Archived Requirements

> Status: Archived | Date: July 2026

Superseded PRDs, kept for reference.

**006–008** originated in the honeycomb repository while the always-on portal still lived there. Under the fleet realignment (hive ADR-0001, ADR-0002, ADR-0004) the portal, boot experience, and health surface moved to hive, and each of these documents was superseded by an active hive PRD before any implementation began. They were moved out of honeycomb's backlog (honeycomb keeps its own archived originals under `honeycomb/library/requirements/archive/`) and renumbered into hive's sequence here so the historical scoping stays with the owning repo.

**002** is a different case: it was authored and partially implemented in hive, but its central deliverable — the client-side `ReadinessSplash` gate — was deliberately deleted when PRD-003 moved the landing decision (fleet health, then auth) server-side into hive's portal gate (`src/daemon/gate.ts`) and PRD-004 introduced the `/buzzing` readiness screen. Its `/api/fleet-status` proxy (002a) survived and became shared infrastructure. It is archived rather than completed because the shipped design is not the design this PRD specifies.

| Archived PRD | Origin | Superseded by |
|---|---|---|
| `prd-002-portal-readiness-splash/` | hive PRD-002 | hive [PRD-003](../completed/prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) (server-side portal gate) and [PRD-004](../completed/prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) (`/buzzing` screen) |
| `prd-006-portal-daemon-boot-shell/` | honeycomb PRD-068 | hive [PRD-003](../completed/prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) and [PRD-004](../completed/prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) |
| `prd-007-application-health-dashboard/` | honeycomb PRD-069 | hive [PRD-005](../completed/prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md) plus doctor PRD-001/PRD-002 (telemetry source of truth) |
| `prd-008-first-browser-load-experience/` | honeycomb PRD-070 | hive [PRD-003](../completed/prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) and [PRD-004](../completed/prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) |

These numbers (002, 006-008) are burned: new hive PRDs take `max_n + 1` across `backlog/`, `in-work/`, `completed/`, and `archive/`, so the next new PRD is `prd-013` or higher.

Code citations inside these documents use their original honeycomb-repo-relative paths: bare `src/*` paths refer to the honeycomb repository; `doctor/src/*` paths refer to the doctor repository (now standalone). Relative markdown links reflect the original honeycomb location and are not maintained here; the canonical archived originals with working links live in honeycomb's archive.
