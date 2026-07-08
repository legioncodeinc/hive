# PRD-013b: Dashboard setup completion checklist

> **Parent:** [`prd-013-guided-onboarding-setup`](./prd-013-guided-onboarding-setup-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S

---

## Scope

A completion checklist rendered at the **top of the dashboard, under the KPI band and above the recall area**, that surfaces any of the three PRD-013 setup steps the operator skipped or has not finished. It derives each item's state from a **live daemon read**, renders **only the incomplete items** with a one-click route to finish each, and **removes itself entirely** once all three are complete.

This is the backstop that makes every wizard step in [`prd-013a`](./prd-013a-post-tenancy-setup-steps.md) safely skippable: nothing skipped is ever lost, and the dashboard is honest about what remains.

### Out of scope

- The wizard steps themselves — [`prd-013a`](./prd-013a-post-tenancy-setup-steps.md).
- Any persisted "skipped"/"dismissed" state — completion is derived from daemon state, not flagged (the parent Non-Goals; `firstTimeSetupComplete` is deliberately not adopted).
- A dismiss/collapse control — the checklist auto-hides on completion; it is not manually dismissable (product-owner decision: auto-derive + auto-hide).
- Reworking the KPI band, recall area, or harness area — the checklist is a new landmark inserted between the first two.

### Dependencies

- **Reuses:** `wire.secretNames()` / `wire.status()` (key presence + memory reason), `wire.scopeProjects()` (project bound), `usePathRoute` (navigation), the route constants in `registry.tsx`.
- **Complements:** the `Outlet`'s `FirstRunBindCTA` swap for zero-project workspaces (`src/dashboard/web/app.tsx`).

---

## Design

### Placement

`DashboardPage` (`src/dashboard/web/pages/dashboard.tsx`) renders three landmarks: `data-area="kpi-band"`, `data-area="recall-area"`, `data-area="harness-area"`. PRD-013b inserts one new landmark — `<section data-area="setup-checklist">` — **between** the KPI band and the recall area, so it reads as "here is what's left to set up" directly under the headline metrics and above the working surface.

### Derivation (no persisted state)

The checklist component (`OnboardingChecklist`, new file `src/dashboard/web/onboarding-checklist.tsx`) does its own live reads and computes three booleans:

| Item | Complete when | Read |
|---|---|---|
| Add an AI API key | a usable model provider is configured | `wire.status().reasons.memory.provider === "configured"` (authoritative, confirmed 2026-07-08). `wire.secretNames()` presence is NOT sufficient on its own — a key that cannot drive memory (rerank-only, gateway-only) must not read as "done" |
| Add your first project | ≥1 locally-bound project (excluding the `__unsorted__` inbox) | `wire.scopeProjects()` → some `p.boundLocally && p.projectId !== "__unsorted__"` |
| Turn on memory formation | memory formation is enabled | `wire.status().reasons.memory.enabled === true` |

`reasons.memory` is read from `wire.status()` (`GET /api/status`, honeycomb), **not** `wire.health()` (hive liveness carries no `memory` reason) — the same fail-close fix `MemoryFormationSection` documents. The dashboard already receives `healthReasons` via `PageProps`, but that source is not guaranteed to carry `memory`, so the checklist reads `status()` itself for the key/memory items.

### Render rules

- Render **only** the items that are incomplete, in the wizard order (key → project → memory).
- The **memory item is gated** exactly like the wizard step: it appears only once a key is present (`provider === "configured"`) and memory is still off. Before a key exists, the API-key item is the visible prerequisite and the memory item is absent (so the list never shows a step the operator cannot yet do).
- Each row shows the same plain-language *what/why* one-liner as its wizard step, plus a primary control that routes to the day-2 surface that owns the action:
  - Add an AI API key → the Settings route.
  - Add your first project → `PROJECTS_ROUTE`.
  - Turn on memory formation → the Settings route.
  Navigation uses `usePathRoute().navigate` (the checklist calls the hook for its own `navigate`; `PageProps` carries none — multiple `usePathRoute` instances are idiomatic and sync via the route-change broadcast in `src/dashboard/web/router.tsx`). Route-to-finish (not inline actions) was confirmed 2026-07-08 to reuse the tested day-2 controls and avoid duplicating the write flows.
- When **all three are complete**, the component renders `null` — the landmark's contents are absent, not merely hidden. No "all done" banner.
- When a read is **unavailable/failed**, the item degrades to **hidden** (fail-soft), never a false "incomplete" — matching the dashboard's existing fail-soft posture. If every read fails, the checklist renders nothing.

### Relationship to `FirstRunBindCTA`

The dashboard `Outlet` (`src/dashboard/web/app.tsx`) already replaces the whole `DashboardPage` with the prominent `FirstRunBindCTA` when a workspace has **zero** locally-bound projects. So in practice the checklist renders only once ≥1 project is bound, meaning its project item is usually already complete and absent. The project item is retained for completeness/robustness (confirmed 2026-07-08 — it self-hides when satisfied, so it costs nothing and covers edge cases like only the `__unsorted__` inbox being bound), while the zero-project first-run experience stays owned by `FirstRunBindCTA`.

---

## User stories

### US-13b.1 — See what's left, right on the dashboard

**As an** operator who skipped setup steps, **I want** the dashboard to show me what's still incomplete, **so that** I can finish setting up without hunting.

**Acceptance criteria:**
- AC-13b.1.1 Given ≥1 setup item is incomplete, when the dashboard renders, then a checklist appears as a landmark between `data-area="kpi-band"` and `data-area="recall-area"`, listing only the incomplete items in wizard order.
- AC-13b.1.2 Given each incomplete item, when it renders, then it shows a plain-language one-liner of what the step is and why it matters, and a control to finish it.
- AC-13b.1.3 Given I click an item's control, when it activates, then the app navigates to the day-2 surface that owns the action (Settings for key/memory, Projects for a folder).

### US-13b.2 — The checklist is honest and self-clearing

**As an** operator, **I want** the checklist to reflect reality and disappear when I'm done, **so that** it never nags about steps I've completed.

**Acceptance criteria:**
- AC-13b.2.1 Given each item, when the dashboard reads state, then done/not-done is derived from a live daemon read (`secretNames`/`status`, `scopeProjects`, `status.reasons.memory`), with no persisted skip/dismiss state.
- AC-13b.2.2 Given I complete an item from a day-2 surface, when I return to the dashboard, then that item no longer appears in the checklist.
- AC-13b.2.3 Given all three items are complete, when the dashboard renders, then the checklist renders nothing.
- AC-13b.2.4 Given a required read is unavailable, when the dashboard renders, then the affected item degrades to hidden (never a false "incomplete").

### US-13b.3 — The memory item is gated like the wizard

**As an** operator without a key, **I want** the checklist to not offer memory formation yet, **so that** it never lists a step I cannot do.

**Acceptance criteria:**
- AC-13b.3.1 Given no provider key is present, when the checklist renders, then the memory item is absent and the API-key item is shown as the prerequisite.
- AC-13b.3.2 Given a key is present and memory is off, when the checklist renders, then the memory item appears.
- AC-13b.3.3 Given memory is on, when the checklist renders, then the memory item is absent.

---

## Implementation notes

- **New file:** `src/dashboard/web/onboarding-checklist.tsx` — `OnboardingChecklist`. Reads `wire.secretNames()`, `wire.scopeProjects()`, `wire.status()` (via `useSwr`/`usePoll` per the dashboard's hydration conventions), computes the three booleans, renders incomplete rows or `null`. Uses only existing DS tokens and the kit primitives (`Button`, `Badge`), mirroring the panel/row rhythm of `memories.tsx`/`projects.tsx`.
- **Edited file:** `src/dashboard/web/pages/dashboard.tsx` — render `<OnboardingChecklist wire={wire} />` inside a new `<section data-area="setup-checklist">` between the KPI band and recall-area sections. The component self-hides, so the section is safe to always mount (stable layout).
- **Navigation:** call `usePathRoute()` inside `OnboardingChecklist` for its own `navigate`; import `PROJECTS_ROUTE` and the settings route from `registry.tsx` (do not hardcode paths).
- **Provider key names:** reuse `PROVIDER_KEY_NAME` (`src/dashboard/web/panels.tsx:463`) to decide "a known provider key is present" from `secretNames`.
- **Tests:** `tests/dashboard/onboarding-checklist.test.tsx` — renders only incomplete items; routes on click; hides on all-complete; memory item gated on key presence; fail-soft hides items when a read fails. Follow the `@vitest-environment jsdom` + mocked-wire conventions of `memory-formation-section.test.tsx`.

---

## Decisions

Confirmed 2026-07-08 (see the parent index [Decisions](./prd-013-guided-onboarding-setup-index.md#decisions-confirmed-2026-07-08)): checklist items **route** to the day-2 surface that owns each action (rather than acting inline); the **project item is kept** (self-hiding when a project is bound) while `FirstRunBindCTA` continues to own the zero-project first-run case; and the "AI key" item's authoritative done-signal is **`reasons.memory.provider === "configured"`** (not mere `secretNames` presence).
