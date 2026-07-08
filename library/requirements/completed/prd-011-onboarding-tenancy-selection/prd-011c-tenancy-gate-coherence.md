# PRD-011c: Tenancy gate coherence

> Parent: [`prd-011-onboarding-tenancy-selection-index.md`](./prd-011-onboarding-tenancy-selection-index.md)

## Overview

The UI step ([`prd-011a`](./prd-011a-onboarding-tenancy-selection-step.md)) is not the enforcement; the server gate is. The portal landing gate (`createPortalGate`, `src/daemon/gate.ts:121-167`) evaluates one ordered precedence on every non-exempt page navigation: fleet health first (redirect `/buzzing`, `src/daemon/gate.ts:148-151`), then auth (redirect `/login`, `src/daemon/gate.ts:157-160`), then serve. This sub-PRD extends the precedence with a third check: tenancy. An authenticated operator whose tenancy is unconfirmed is redirected to `/onboarding` (already gate-exempt, `GATE_EXEMPT_ROUTES`, `src/daemon/gate.ts:52-55`), where the flow resumes at the tenancy step (ts-AC-10). The dashboard is structurally unreachable while tenancy is unconfirmed.

The check mirrors the auth check's construction exactly: a small, injectable, fail-closed proxied read. `fetchSetupAuthenticated` (`src/daemon/setup-auth.ts:49-76`) resolves honeycomb's loopback base via `resolveDaemonBases`, re-checks loopback (defense in depth), fetches `/setup/state`, parses with a `.catch()`-defaulted zod schema, and returns `false` on ANY failure. The new `fetchTenancySelected` does the same against the proposed `GET /setup/tenancy` (parent index contract), returning the `selected` bit and failing closed to `false`: a transient fault reads as unconfirmed and lands on `/onboarding`, never fail-soft into the dashboard.

The signal separation matters as much as the gate itself: "waiting for tenancy selection" must never be conflated with "fleet unhealthy". `/buzzing` keeps meaning exactly one thing, the PRD-002 lineage readiness view over `isFleetReady()` (`src/dashboard/web/buzzing-screen.tsx:7-12`; the shared predicate pinned across the gate and the screen, `src/daemon/gate.ts:145-151`). Tenancy-waiting renders inside the onboarding flow with its own copy, and the gate's redirect targets encode the distinction: unhealthy goes to `/buzzing`, tenancy-unconfirmed goes to `/onboarding`.

## Goals

- The gate's precedence becomes health, then auth, then tenancy, then serve; each check keeps its fixed hard-coded redirect literal (the g-AC-11 open-redirect posture, `src/daemon/gate.ts:28-31`).
- The tenancy read fails closed: any fetch failure, non-OK response, malformed body, or non-loopback base reads as unconfirmed.
- `/buzzing` and its feeding surfaces keep meaning fleet health only; the tenancy-wait state is a distinct onboarding-flow surface with distinct copy.
- No redirect loop is possible: `/onboarding` is already in the exemption set, so the tenancy redirect's target cannot itself produce a redirect (the same structural guarantee as `/buzzing` and `/login`, `src/daemon/gate.ts:137-143`).

## Non-Goals

- Changing the health or auth checks, their order relative to each other, or their redirect targets.
- Gating the data plane: `/api/*` and `/setup/*` stay proxy-handled infra paths the gate bypasses (`src/daemon/gate.ts:71,131-135`); daemon-side refusal of pre-tenancy capture writes is the parallel honeycomb PRD's dormancy obligation, not a hive gate concern.
- New readiness vocabulary in the shared fleet-readiness module; tenancy is not a fleet-health state.

---

## User stories + acceptance criteria

### US-1 - the precedence gains tenancy

**As** the portal, **I** never serve the dashboard to an operator whose tenancy is unconfirmed.

| ID | Criterion |
|---|---|
| tg-AC-1 | Given a healthy fleet and an authenticated operator with tenancy unconfirmed (`selected: false`), when any non-exempt route is requested, then the gate 302-redirects to `/onboarding`, a fixed hard-coded literal (never derived from the request), and the health and auth checks have already passed in order before the tenancy check runs. |
| tg-AC-2 | Given an unhealthy fleet, when any non-exempt route is requested, then the redirect is `/buzzing` and the tenancy check never runs (health stays first, `src/daemon/gate.ts:148-151`); given an unauthenticated operator on a healthy fleet, the redirect is `/login` and the tenancy check never runs (auth stays second). |
| tg-AC-3 | Given a healthy fleet, an authenticated operator, and `selected: true`, when a non-exempt route is requested, then the gate calls `next()` and the route serves as today (`src/daemon/gate.ts:162-165`). |
| tg-AC-4 | Given the tenancy read fails (network error, timeout, non-OK, malformed JSON, schema mismatch, or a non-loopback resolved base), when the gate evaluates, then the result is unconfirmed and the redirect is `/onboarding`; there is no code path where a tenancy-read fault serves the dashboard. |

### US-2 - the fail-closed read

**As** the gate, **my** tenancy input is a small injectable read that cannot lie optimistically.

| ID | Criterion |
|---|---|
| tg-AC-5 | Given the new read module, when implemented, then it mirrors `fetchSetupAuthenticated`'s construction (`src/daemon/setup-auth.ts:49-76`): resolves the honeycomb base through `resolveDaemonBases`, re-checks `isLoopbackBaseUrl` before fetching, pins `redirect: "error"`, threads the incoming request's abort signal, parses with a `.catch()`-defaulted zod schema, and returns `false` on any failure. |
| tg-AC-6 | Given the gate already fetches `/setup/state` for auth on the same request, when the tenancy check is added, then the two reads are either coalesced into one upstream round trip or explicitly justified as separate fetches (DEFAULT - confirm before implementation: coalesce if the parallel honeycomb PRD surfaces `selected` on `/setup/state`; otherwise one additional loopback fetch per gated page navigation is accepted, matching the gate's existing per-navigation fetch budget). |
| tg-AC-7 | Given `createPortalGate`'s options (`src/daemon/gate.ts:103-112`), when the check is added, then it gains an injectable fetch seam (mirroring `setupAuthFetch`) so unit tests drive all four outcomes (confirmed, unconfirmed, read failure, non-loopback) without a network. |

### US-3 - distinct signals

**As** the operator, **I** can always tell "the fleet is not ready" apart from "you have not picked a tenancy".

| ID | Criterion |
|---|---|
| tg-AC-8 | Given tenancy is unconfirmed, when the operator lands anywhere, then the surface they end on is the onboarding flow's tenancy step with copy about selecting an org and workspace; `/buzzing` renders only for fleet-health redirects and its copy and tiles are unchanged by this PRD (`src/dashboard/web/buzzing-screen.tsx:33-61`). |
| tg-AC-9 | Given the fleet is BOTH unhealthy and tenancy-unconfirmed, when the operator visits, then health wins (redirect `/buzzing`); once the fleet becomes ready, the buzzing screen's existing hard navigation to `/` (`src/dashboard/web/buzzing-screen.tsx:8-12`) re-runs the gate, which then redirects to `/onboarding` for tenancy: the operator flows through both signals in order, each on its own surface. |
| tg-AC-10 | Given the readiness vocabulary, when audited after implementation, then no tenancy state appears in `src/shared/fleet-readiness.ts`, `use-fleet-telemetry.ts`, the health rail, or the buzzing tiles; tenancy-waiting is expressed only on the onboarding surface and the gate's redirect choice. |

---

## Implementation notes

### Why redirect to `/onboarding` rather than a new route

`/onboarding` is already gate-exempt (`src/daemon/gate.ts:52-55`) and already owns resume logic that inspects daemon state and drops the operator into the right phase (`src/dashboard/web/onboarding/onboarding-screen.tsx:204-224`). ts-AC-10 extends that resume to land on the tenancy phase for an installed, authenticated, unselected machine. A dedicated `/tenancy` route would be a second exempt surface with duplicated resume logic (DEFAULT - confirm before implementation, per the parent's open questions).

### Ordering rationale

Tenancy is checked third because it is meaningless earlier: an unhealthy fleet cannot serve the selection UI's upstream calls, and an unauthenticated operator has no org list to enumerate. The order also preserves the PRD-003 invariant that `/buzzing` is the first stop for a broken fleet.

## Related

- [`prd-011-onboarding-tenancy-selection-index.md`](./prd-011-onboarding-tenancy-selection-index.md) - the `GET /setup/tenancy` contract the read consumes.
- [`prd-011a-onboarding-tenancy-selection-step.md`](./prd-011a-onboarding-tenancy-selection-step.md) - the surface the redirect lands on (ts-AC-10 resume).
- hive [`prd-002-portal-readiness-splash`](../../in-work/prd-002-portal-readiness-splash/prd-002-portal-readiness-splash-index.md) - the readiness lineage whose single meaning this PRD protects.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the gate architecture extended here.
- `src/daemon/gate.ts:28-31,52-55,103-167` - the open-redirect posture, exemption set, options seam, and precedence.
- `src/daemon/setup-auth.ts:49-76` - the fail-closed read pattern to mirror.
- `src/daemon/fleet-status.ts:16-19,45-84` - the health input, untouched.
- `src/dashboard/web/buzzing-screen.tsx:7-12,33-61` - the fleet-health surface kept single-purpose.
