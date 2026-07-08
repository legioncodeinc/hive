# PRD-003a: Route model and server-side gate

> Parent: [`prd-003-portal-landing-gate-and-routing-index.md`](./prd-003-portal-landing-gate-and-routing-index.md)

## Overview

This sub-PRD delivers the path-based route model hive serves and the **server-side gate** that decides what to serve, implementing the precedence in hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md). It replaces the client hash router (`hive/src/dashboard/web/router.tsx`, `useHashRoute` / `routeFromHash`) as the authority for which screen an operator may reach: hive's server evaluates health-then-auth before it serves any route, so a logged-out or unhealthy visitor never receives dashboard chrome to flash.

The gate reads its two inputs through surfaces that already exist: fleet health via hive's own `GET /api/fleet-status` (PRD-002a, a projection of doctor's status page), and the `authenticated` bit via the proxied honeycomb `GET /setup/state` (the BFF proxy from [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md), `hive/src/daemon/proxy.ts`). It introduces no new credential and no portal session.

## Goals

- hive serves each screen at a real path; the server decides `/buzzing` vs `/login` vs the requested route before the browser renders.
- The gate applies the ADR-0004 precedence exactly: fleet health first, then auth, then the requested route defaulting to `/`.
- `/buzzing` and `/login` are exempt so the redirect terminates and can never loop.
- The decision is refresh-safe and deep-link-safe: the same precedence runs on every entry because the path (not a fragment) carries the route.

## Non-Goals

- The `/login` route's device-flow rendering and the exact `/setup/state` read details - that is [`prd-003b`](./prd-003b-login-route-device-flow.md); this sub-PRD only consumes the `authenticated` bit as the gate's second input.
- Migrating the existing pages off hash addressing - that is [`prd-003c`](./prd-003c-hash-to-path-migration.md); this sub-PRD defines the route model those pages will be served under.
- The `/buzzing` screen's contents and the `/health` page - [`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md) and [`prd-005`](../prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md).
- Defining fleet health itself - doctor owns it (doctor [`ADR-0001`](../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)); the gate consumes the ready/not-ready signal.

---

## User stories + acceptance criteria

### US-1 - path-based route model served by hive

**As** an operator, **when** I open or deep-link a screen, **I** reach it by a real path, not a URL fragment.

| ID | Criterion |
|---|---|
| g-AC-1 | Given hive's server, when it serves the SPA, then each screen is addressable at a real path (`/`, `/projects`, `/harnesses`, `/memories`, `/graph`, `/sync`, `/logs`, `/roi`, `/settings`, plus `/buzzing` and `/login`), and the server (not `location.hash`) determines the served route. |
| g-AC-2 | Given a request for a gated path, when the gate passes, then hive serves the SPA shell for that path so client rendering resolves the same screen the path names, with no fragment involved. |

### US-2 - health-first, then auth precedence

**As** an operator, **when** I land on any route, **I** am sent to the one correct screen for the fleet and credential state.

| ID | Criterion |
|---|---|
| g-AC-3 | Given a landing on ANY route, when the fleet is not healthy (doctor reports required services unhealthy, or doctor is unreachable), then hive redirects to `/buzzing` before evaluating auth. |
| g-AC-4 | Given a healthy fleet, when the operator has no valid `~/.deeplake/credentials.json` (the proxied `/setup/state` `authenticated` bit is false), then hive redirects to `/login`. |
| g-AC-5 | Given a healthy fleet and an authenticated operator, when the requested route is `/` or omitted, then hive serves `/`, which IS the dashboard; `/` is never blank and the dashboard is never served at `/dashboard`. |
| g-AC-6 | Given a healthy fleet and an authenticated operator who requested a specific screen (for example `/memories`), when the gate passes, then hive serves that requested route rather than forcing `/`. |

### US-3 - exempt screens never loop

**As** an operator on the readiness or login screen, **when** the fleet is down or I am logged out, **I** stay on that screen instead of bouncing.

| ID | Criterion |
|---|---|
| g-AC-7 | Given a landing on `/buzzing`, when the gate runs, then `/buzzing` is exempt and is served directly regardless of fleet health or auth state, never redirected. |
| g-AC-8 | Given a landing on `/login`, when the gate runs, then `/login` is exempt and is served directly regardless of auth state, never redirected (its own completion is what flips auth, per [`prd-003b`](./prd-003b-login-route-device-flow.md)). |
| g-AC-9 | Given an unhealthy fleet and a logged-out operator, when they are redirected to `/buzzing` then later to `/login` as state changes, then no sequence of gate evaluations produces a redirect loop between exempt and non-exempt routes. |

### US-4 - refresh-safe and deep-link-safe

**As** an operator, **when** I refresh or paste a URL, **I** get the same authoritative decision.

| ID | Criterion |
|---|---|
| g-AC-10 | Given a refresh or a directly pasted gated path, when hive handles it, then the identical health-then-auth precedence runs server-side, independent of any prior client state, so the served screen matches current fleet and credential state. |
| g-AC-11 | Given the gate's redirects, when audited, then redirect targets are limited to the fixed internal set (`/buzzing`, `/login`, or a same-origin requested route); no user-supplied value can drive an open redirect off hive's origin. |

---

## Implementation notes

### Where the gate lives

The gate is hive server logic that runs for gated path requests, sitting on the same tier that already owns the BFF proxy (`hive/src/daemon/proxy.ts`) and the `GET /api/fleet-status` route (PRD-002a, `hive/src/daemon/server.ts`). It reads the same two truths those surfaces already expose, so the gate adds decision logic, not a new data source or a new cross-origin surface.

### Precedence as a single ordered decision

The precedence is one ordered evaluation, health then auth then route, mirroring the ADR-0004 flowchart. Fleet readiness reuses PRD-002a's `isFleetReady()` predicate so "healthy" means the same thing on the gate as it does on `/buzzing`; the gate never re-derives readiness from raw doctor fields. Auth is the proxied `/setup/state` `authenticated` bit, read per [`prd-003b`](./prd-003b-login-route-device-flow.md), with a proxy failure treated as "not authenticated" so a transient proxy fault falls to `/login`, never silently into the dashboard.

### Exemption set

`/buzzing` and `/login` are a fixed exemption set checked before the precedence, so they are always served directly. This is what guarantees the redirect terminates: the two possible redirect destinations are themselves exempt.

## Related

- [`prd-003-portal-landing-gate-and-routing-index.md`](./prd-003-portal-landing-gate-and-routing-index.md) - module scope and the ADR-0004 precedence.
- [`prd-003b-login-route-device-flow.md`](./prd-003b-login-route-device-flow.md) - the `/login` route and the `authenticated` read the gate's auth step depends on.
- [`prd-003c-hash-to-path-migration.md`](./prd-003c-hash-to-path-migration.md) - the migration of existing pages onto this route model.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the gate precedence, exemptions, and server-side authority.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the proxy the gate reads `/setup/state` through.
- hive [`prd-002a-fleet-status-proxy`](../../in-work/prd-002-portal-readiness-splash/prd-002a-fleet-status-proxy.md) - the `GET /api/fleet-status` route and `isFleetReady()` predicate the gate's health step reuses.
- `hive/src/dashboard/web/router.tsx` - `useHashRoute` / `routeFromHash`, the client router this gate supersedes as the routing authority.
- `hive/src/daemon/proxy.ts` - the server proxy the gate reads auth through.
