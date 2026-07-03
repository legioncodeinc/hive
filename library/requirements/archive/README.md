# Archived Requirements

> Status: Archived | Date: July 2026

Superseded PRDs, kept for reference. These originated in the honeycomb repository while the always-on portal still lived there. Under the fleet realignment (hive ADR-0001, ADR-0002, ADR-0004) the portal, boot experience, and health surface moved to hive, and each of these documents was superseded by an active hive PRD before any implementation began. They were moved out of honeycomb's backlog (honeycomb keeps its own archived originals under `honeycomb/library/requirements/archive/`) and renumbered into hive's sequence here so the historical scoping stays with the owning repo.

| Archived PRD | Origin | Superseded by |
|---|---|---|
| `prd-006-portal-daemon-boot-shell/` | honeycomb PRD-068 | hive [PRD-003](../backlog/prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) and [PRD-004](../backlog/prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) |
| `prd-007-application-health-dashboard/` | honeycomb PRD-069 | hive [PRD-005](../backlog/prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md) plus doctor PRD-001/PRD-002 (telemetry source of truth) |
| `prd-008-first-browser-load-experience/` | honeycomb PRD-070 | hive [PRD-003](../backlog/prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) and [PRD-004](../backlog/prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) |

These numbers (006-008) are burned: new hive PRDs take `max_n + 1` across `backlog/`, `in-work/`, `completed/`, and `archive/`, so the next new PRD is `prd-009` or higher.

Code citations inside these documents use their original honeycomb-repo-relative paths: bare `src/*` paths refer to the honeycomb repository; `doctor/src/*` paths refer to the doctor repository (now standalone). Relative markdown links reflect the original honeycomb location and are not maintained here; the canonical archived originals with working links live in honeycomb's archive.
