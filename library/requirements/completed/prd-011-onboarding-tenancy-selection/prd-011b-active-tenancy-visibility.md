# PRD-011b: Active-tenancy visibility

> Parent: [`prd-011-onboarding-tenancy-selection-index.md`](./prd-011-onboarding-tenancy-selection-index.md)

## Overview

Once a tenancy is selected, the operator must always be able to see where data is being written. Today the only tenancy readout is the sidebar identity sub-line, a string built in the shell as `` `${settings.orgName || settings.orgId || "local"} · ${settings.workspace || "default"}` `` (`src/dashboard/web/app.tsx:200`) from `GET /api/diagnostics/settings` (`SettingsSchema`: `orgId`, `orgName`, `workspace`, `src/dashboard/web/wire.ts:204-210`), passed to the `Sidebar` and invisible when the sidebar is collapsed. Its `|| "local"` / `|| "default"` fallbacks also fabricate a tenancy when the read fails, exactly the dishonesty this PRD removes.

This sub-PRD adds two surfaces:

1. **A persistent shell-chrome tenancy display.** Proposed placement (DEFAULT - confirm before implementation): in the chrome bar that hosts the "Pollinate now" action (`src/dashboard/web/app.tsx:231-244`), left-aligned opposite the button, directly below the fleet health rail mount (`HealthRail`, `src/dashboard/web/app.tsx:228`). This keeps the health rail single-purpose (per-service pills, `src/dashboard/web/health-rail.tsx:81-127`) while placing the tenancy in the same always-visible chrome band on every in-app route.
2. **The tenancy line on the nectar projects panel.** `NectarProjectsPanel` (`src/dashboard/web/pages/hive-graph.tsx:92`, the PRD-019c surface) gains a readout of the tenancy its projects write to, so the panel that activates brooding also names the destination org and workspace.

Both render honestly: an unreachable source shows "tenancy unavailable", an unlinked credential shows "not linked", and an unconfirmed selection shows "tenancy not selected", following the established fail-soft posture (`UNREACHABLE_RESPONSE`, `src/daemon/fleet-status.ts:16-19`; the panel's existing unreachable branch, `src/dashboard/web/pages/hive-graph.tsx:163-169`). No surface ever fabricates `local · default`.

## Goals

- The active org and workspace are visible on every in-app route without expanding the sidebar.
- The nectar projects panel names the tenancy its projects write into.
- Every degraded state (daemon unreachable, credential unlinked, tenancy unconfirmed) renders distinctly and honestly.
- The displayed tenancy always reflects the daemon's persisted truth, not a client-side cache: a day-2 org/workspace switch (IRD-122) is reflected on the next hydrate.

## Non-Goals

- Making the display interactive. Switching tenancy remains the scope switcher's job (`ScopeSwitcherSlot`, `src/dashboard/web/scope-context.tsx:398`); this is a readout.
- Redesigning the health rail or the sidebar.
- Nectar-side changes to the projects body (coordinated with nectar [`prd-019c`](../../../../../nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019c-hive-dashboard-project-activation.md); hive parses leniently either way).

---

## User stories + acceptance criteria

### US-1 - the shell readout

**As** the operator, **wherever** I am in the dashboard, **I** can see the active org and workspace.

| ID | Criterion |
|---|---|
| tv-AC-1 | Given a healthy, linked, tenancy-selected fleet, when any in-app route renders, then the shell chrome shows the active org display name and workspace name, visible with the sidebar expanded or collapsed. |
| tv-AC-2 | Given the tenancy read fails or the owning daemon is unreachable, when the shell renders, then the readout shows an explicit unavailable state (proposed copy: "tenancy unavailable"), never a fabricated `local · default`; the `|| "local"` / `|| "default"` fallbacks in the identity string (`src/dashboard/web/app.tsx:200`) do not propagate into this surface. |
| tv-AC-3 | Given the credential is unlinked (`authenticated: false`) or the tenancy is unconfirmed (`selected: false`), when the shell renders (reachable only through gate exemptions or a mid-session logout), then the readout distinguishes "not linked" from "tenancy not selected". |
| tv-AC-4 | Given the tenancy source, when the readout hydrates, then it reads the daemon's persisted truth (the proposed `GET /setup/tenancy`, or `GET /api/diagnostics/settings` if the parallel honeycomb PRD lands the selected tenancy there; DEFAULT - confirm which read at implementation, pinned with the contract) and re-hydrates on the shell's existing recovery path (`hydrateIdentity` on down-to-up transitions, `src/dashboard/web/app.tsx:129-152`). |
| tv-AC-5 | Given a day-2 org or workspace switch persists (IRD-122 switch feedback, `src/dashboard/web/scope-context.tsx:257-303`), when the switch acknowledges, then the readout reflects the new tenancy without a full page reload. |

### US-2 - the nectar projects panel

**As** the operator activating brooding, **I** see which tenancy those projects write to.

| ID | Criterion |
|---|---|
| tv-AC-6 | Given the panel renders with nectar reachable, when projects are listed (or the empty pick-a-folder state shows), then a tenancy line names the org and workspace the projects' captured data lands in. |
| tv-AC-7 | Given nectar is unreachable, when the panel renders its existing unreachable state (`src/dashboard/web/pages/hive-graph.tsx:163-169`), then no tenancy is shown for it (the unreachable message stands alone); the panel never pairs an unreachable daemon with a confidently-stated tenancy. |
| tv-AC-8 | Given the tenancy source for the panel, when nectar's proxied `GET /api/hive-graph/projects` body (parsed by `NectarProjectsBodySchema`, `src/dashboard/web/wire.ts:952-956`) carries tenancy fields, then they are parsed leniently (`.catch()`-defaulted, absent fields degrade to "tenancy unknown") and displayed per the body; when absent, the panel falls back to the fleet-shared credential's tenancy (the tv-AC-4 read) labeled as such (DEFAULT - confirm before implementation, coordinate the body extension with nectar [`prd-019c`](../../../../../nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019c-hive-dashboard-project-activation.md)). |

---

## Implementation notes

### Placement rationale (the flagged default)

Three candidates were considered. (1) Inside the health rail: rejected as a default because the rail is a `role="status"` aria-live region of service pills (`src/dashboard/web/health-rail.tsx:86-89`); a tenancy readout there would announce on tenancy changes and muddy the rail's single vocabulary. (2) Promoting the sidebar identity line: rejected as a default because it collapses with the rail (`ScopeSwitcherSlot` renders nothing when collapsed, `src/dashboard/web/scope-context.tsx:404`). (3) The chrome bar beside "Pollinate now": chosen as the default; it is mounted on every route, currently left-empty (`<span style={{ flex: 1 }} />`, `src/dashboard/web/app.tsx:240`), and sits adjacent to the health rail so fleet health and fleet tenancy read as one chrome band. Exact placement is flagged: DEFAULT - confirm before implementation.

### Honesty over fallback

The existing `settings` wire schema `.catch()`es every field to `""` (`src/dashboard/web/wire.ts:204-210`), which is correct at the parse boundary; the dishonesty enters when display code substitutes `local`/`default` for the empty string. The new readout maps empty/failed to the explicit unavailable states instead.

## Related

- [`prd-011-onboarding-tenancy-selection-index.md`](./prd-011-onboarding-tenancy-selection-index.md) - the proposed `GET /setup/tenancy` read.
- [`prd-011a-onboarding-tenancy-selection-step.md`](./prd-011a-onboarding-tenancy-selection-step.md) - where the displayed selection is made.
- nectar [`prd-019c-hive-dashboard-project-activation`](../../../../../nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019c-hive-dashboard-project-activation.md) - the panel this extends and the coordination point for tenancy fields in the projects body.
- `src/dashboard/web/app.tsx:128-152,200,228,231-244` - the identity hydration, the fabricating fallback, and the chrome band.
- `src/dashboard/web/health-rail.tsx:81-127` - the rail kept single-purpose.
- `src/dashboard/web/pages/hive-graph.tsx:92,163-169` - the panel and its unreachable posture.
- `src/dashboard/web/wire.ts:204-210,932-981` - the settings read and the nectar projects schemas.
- `src/dashboard/web/scope-context.tsx:257-303,398-404` - the day-2 switcher whose persisted switches the readout must reflect.
