# PRD-011a: The onboarding tenancy selection step

> Parent: [`prd-011-onboarding-tenancy-selection-index.md`](./prd-011-onboarding-tenancy-selection-index.md)

## Overview

The onboarding flow ends today at the login step: when the polled `/setup/state.authenticated` bit flips true, `LoginStep` fires `dashboard_reached`, best-effort POSTs `/api/onboarding/complete`, and hard-navigates to `/` (`src/dashboard/web/onboarding/login-step.tsx:113-125`). This sub-PRD interposes a mandatory TENANCY phase: authenticated no longer means done. The `OnboardingScreen` state machine (`Phase` union, `src/dashboard/web/onboarding/onboarding-screen.tsx:47-54`) gains a `tenancy` phase between `login` and the terminal navigation, and the `dashboard_reached` event plus the `/api/onboarding/complete` beacon move to fire only after the selection persists.

The step's data comes from the honeycomb daemon through the existing same-origin `/setup/*` BFF proxy leg (`src/daemon/proxy.ts:105`; `/setup/` is gate-exempt data-plane traffic, `src/daemon/gate.ts:71`), against the proposed contract in the parent index (`GET /setup/tenancy`, `GET /setup/tenancy/orgs`, `GET /setup/tenancy/workspaces?org=`, `POST /setup/tenancy/select`, and the flagged `POST /setup/tenancy/workspaces`). Those endpoints are owned by the honeycomb PRD (dormant-by-default capture and explicit tenancy selection), authored in parallel; this UI is coded against the proposed shape and the field names are pinned at implementation, exactly the discipline the PRD-009b installer contract used (`src/dashboard/web/onboarding/contracts.ts:1-11`: local types mirroring a parallel daemon-side contract field-for-field).

## Goals

- Authenticated never navigates to `/` directly; the tenancy phase always runs (selection or single-org confirm) before the terminal handoff.
- The org picker lists every org the credential can enumerate; a single-org account gets an explicit confirm naming the org, never a silent pass-through.
- The workspace picker lists the chosen org's workspaces; a create-new affordance renders only when the daemon reports `canCreate: true` (DEFAULT - confirm before implementation).
- The selection persists via `POST /setup/tenancy/select` and the flow advances only on an acknowledged `selected: true`.
- Re-entry is idempotent: an installed, authenticated machine with tenancy already selected short-circuits past the step; one with tenancy unselected resumes AT the step (no re-install, no re-login).
- Failures render honestly with retry affordances, mirroring the login step's error posture (`src/dashboard/web/onboarding/login-step.tsx:155-158`).

## Non-Goals

- The daemon-side endpoints, the durable selected marker, and capture dormancy (the parallel honeycomb PRD).
- Any change to the phases before login (detect, hero, picker, installing, health are untouched).
- The day-2 scope switcher (`ScopeSwitcherSlot`, `src/dashboard/web/scope-context.tsx:398`).
- Workspace creation as a hard requirement (flagged DEFAULT; the step ships without it if the API cannot create).

---

## User stories + acceptance criteria

### US-1 - the flow blocks on tenancy

**As** a new operator, **when** my device-code login completes, **I** am asked to pick my org and workspace before anything else happens.

| ID | Criterion |
|---|---|
| ts-AC-1 | Given the login step's `/setup/state` poll reports `authenticated: true`, when the state machine advances, then the next phase is `tenancy`, and neither `dashboard_reached`, nor `POST /api/onboarding/complete`, nor `window.location.assign("/")` (`src/dashboard/web/onboarding/login-step.tsx:116-123`) has fired. |
| ts-AC-2 | Given the tenancy phase mounts, when it hydrates, then it reads `GET /setup/tenancy` first; a body with `selected: true` short-circuits the step (straight to the terminal handoff), and a body with `selected: false` renders the org list from `GET /setup/tenancy/orgs`. |
| ts-AC-3 | Given the org enumeration returns exactly one org, when the step renders, then it shows a confirm screen naming that org (name and id) with an explicit confirm action instead of a picker; confirming proceeds to the workspace list. A zero-org body renders an honest error (the daemon-side rule that an account must have at least one org, honeycomb `src/daemon/runtime/auth/deeplake-issuer.ts:525`, makes this a failure state, not a flow state). |
| ts-AC-4 | Given more than one org, when the list renders, then every org shows its display name, none is preselected as chosen, and choosing one loads `GET /setup/tenancy/workspaces?org=<id>` for that org. |

### US-2 - workspace selection and the flagged create

**As** the operator, **when** I have chosen an org, **I** pick the workspace capture will write to.

| ID | Criterion |
|---|---|
| ts-AC-5 | Given the workspace enumeration resolves, when the list renders, then every workspace shows its display name and the operator must actively choose one (no preselected `default`). |
| ts-AC-6 | Given the daemon reports `canCreate: true`, when the list renders, then a create-new-workspace affordance is offered; submitting a name POSTs `/setup/tenancy/workspaces` and a `created: true` ack selects the new workspace. Given `canCreate: false` (or the field is absent), the affordance never renders. (DEFAULT - confirm before implementation: creation ships only if the Deeplake API supports it.) |
| ts-AC-7 | Given an org with zero workspaces and `canCreate: false`, when the list renders, then the step shows an honest "no workspaces available in this org" state with a back-to-org-list affordance, never a fabricated `default` entry. |

### US-3 - persistence and the terminal handoff

**As** the fleet, **when** the operator confirms, **the** selection is durable before the dashboard exists.

| ID | Criterion |
|---|---|
| ts-AC-8 | Given the operator confirms an org + workspace, when the step persists, then it POSTs `/setup/tenancy/select` with `{ orgId, workspaceId }` (the canonical 073c body) and advances only on an acknowledged `selected: true`; a `selected: false` ack (or a non-2xx / network failure, degraded through the same fail-soft parse discipline as `wire.ts`) renders the redacted error with a retry, and the flow does not advance. |
| ts-AC-9 | Given a `selected: true` ack, when the flow completes, then `dashboard_reached` fires, `POST /api/onboarding/complete` is best-effort POSTed, and the hard navigation to `/` runs, in that order, relocated from the login step (`src/dashboard/web/onboarding/login-step.tsx:113-125`) so the server gate revalidates health, auth, AND tenancy on the fresh request. |
| ts-AC-10 | Given a machine re-entering `/onboarding` fully installed and authenticated but with `selected: false`, when detection resolves, then the flow resumes directly at the tenancy phase (no hero, no install cards, no second device-code prompt), extending the PRD-009b resume-honesty posture (`src/dashboard/web/onboarding/onboarding-screen.tsx:204-224`). |

### US-4 - wire client and telemetry

**As** the codebase, **the** tenancy wire surface follows the established onboarding conventions.

| ID | Criterion |
|---|---|
| ts-AC-11 | Given the tenancy wire client, when implemented, then it lives in the onboarding feature folder beside `onboarding-client.ts`, validates every body with zod using `.catch()`-defaulted fields (a malformed body degrades to `selected: false` / empty lists, never a throw into React), and marks the contract module as mirroring the parallel honeycomb PRD's proposed shape, pinned at implementation. |
| ts-AC-12 | Given the tenancy calls, when they fire, then they ride hive's same-origin `/setup/*` proxy path with no onboarding token required (matching `/setup/login` and `/setup/state`, which `LoginStep` reaches through the plain `WireClient`, `src/dashboard/web/onboarding/login-step.tsx:65`); no token or secret appears in any request or response body. |
| ts-AC-13 | Given the funnel, when the step runs, then it emits `tenancy_shown` (the step rendered), `tenancy_selected` (the persist acknowledged; properties: org count bucket and whether the single-org confirm path ran), and, when applicable, `workspace_created`, through the same fire-and-forget chokepoint as the existing UI events (`sendEvent`, `src/dashboard/web/onboarding/onboarding-client.ts:178-187`), extending the PRD-009c event list. |

---

## Implementation notes

### Where the phase slots in

`Phase` (`src/dashboard/web/onboarding/onboarding-screen.tsx:47-54`) gains `{ kind: "tenancy" }`. `LoginStep`'s authenticated effect stops navigating and instead reports up (`onAuthenticated` already exists as a seam, `src/dashboard/web/onboarding/login-step.tsx:29`); the screen advances `login -> tenancy`. The terminal actions (`dashboard_reached`, `complete()`, `window.location.assign("/")`) move into the tenancy step's post-select handler. The `clearSelection()` call on the terminal path (`src/dashboard/web/onboarding/onboarding-screen.tsx:266-269`) moves with them.

### Single-org confirm

The confirm is a real screen, not an auto-advance: the wrong-org incident happened precisely because a plausible default was silently applied. Even with one org, the workspace choice that follows is still a choice; the confirm establishes the operator saw and accepted the org.

### Relationship to the existing scope reads

The dashboard-side enumerations (`GET /api/diagnostics/scope/orgs` / `workspaces`, hive wire `src/dashboard/web/wire.ts:112-113`) are RBAC'd dashboard diagnostics routes on honeycomb; the onboarding context needs a pre-dashboard, `/setup/*`-class surface, which is why the parent index proposes `/setup/tenancy/*` beside `/setup/state` and `/setup/login` rather than reusing the diagnostics group. The parallel honeycomb PRD decides whether the two families share handlers server-side.

## Related

- [`prd-011-onboarding-tenancy-selection-index.md`](./prd-011-onboarding-tenancy-selection-index.md) - the proposed contract and locked decisions.
- [`prd-011c-tenancy-gate-coherence.md`](./prd-011c-tenancy-gate-coherence.md) - the server-side check that backs this step (the UI alone is not the enforcement).
- hive [`prd-009b-onboarding-route-and-guided-flow`](../../in-work/prd-009-onboarding-installer/prd-009b-onboarding-route-and-guided-flow.md) - the flow this step extends.
- hive [`prd-009c-onboarding-telemetry`](../../in-work/prd-009-onboarding-installer/prd-009c-onboarding-telemetry.md) - the funnel the new events extend.
- `src/dashboard/web/onboarding/onboarding-screen.tsx:47-54,204-224,264-269` - the state machine, resume logic, and terminal cleanup.
- `src/dashboard/web/onboarding/login-step.tsx:113-125` - the relocated terminal handoff.
- `src/dashboard/web/onboarding/contracts.ts:1-11` - the mirror-the-parallel-contract discipline.
- honeycomb `src/daemon/runtime/auth/deeplake-issuer.ts:523-534` - the guessed defaults this step supersedes on the human path.
