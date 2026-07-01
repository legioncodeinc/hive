# PRD-003c: Migration from hash routing to path-based routing

> Parent: [`prd-003-portal-landing-gate-and-routing-index.md`](./prd-003-portal-landing-gate-and-routing-index.md)

## Overview

This sub-PRD migrates the copied dashboard SPA off client hash routing and onto the path-based route model [`prd-003a`](./prd-003a-route-model-and-server-gate.md) defines, per the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md). It retires `useHashRoute` / `routeFromHash` (`the-hive/src/dashboard/web/router.tsx`) as the router and converts `the-hive/src/dashboard/web/registry.tsx` from hash addressing to path addressing, while preserving every existing page's content unchanged.

The migration also unwinds the two nested React gates in `the-hive/src/dashboard/web/main.tsx` (`ReadinessSplash` then `SetupGate`): the health and auth decisions move to the server gate ([`prd-003a`](./prd-003a-route-model-and-server-gate.md)), the `ReadinessSplash` concept becomes the `/buzzing` route ([`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md)), and `SetupGate`'s device-flow view becomes the `/login` route ([`prd-003b`](./prd-003b-login-route-device-flow.md)). This is a routing-layer migration only: no page's data, layout, or behavior changes.

## Goals

- `useHashRoute` / `routeFromHash` are retired as the SPA's route resolver in favor of path-based routing that matches the server route model.
- `registry.tsx`'s route set is served at real paths, and every existing page renders unchanged behind its new path.
- The nested `ReadinessSplash` / `SetupGate` gate tree in `main.tsx` is unwound in favor of the server gate plus the `/buzzing` and `/login` routes.
- No dashboard page loses functionality, layout, or data wiring in the migration.

## Non-Goals

- The server gate and route model themselves - defined in [`prd-003a`](./prd-003a-route-model-and-server-gate.md); this sub-PRD conforms the client SPA to them.
- The `/login` route's device-flow contents - [`prd-003b`](./prd-003b-login-route-device-flow.md); this sub-PRD only relocates `SetupGate`'s view to that route.
- The `/buzzing` screen's loaders and SVGs - [`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md); this sub-PRD only relocates the `ReadinessSplash` mount point to that route.
- Adding new pages (for example `/health`) - [`prd-005`](../prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md); this sub-PRD migrates the existing page set only.

---

## User stories + acceptance criteria

### US-1 - retire the hash router

**As** a maintainer, **when** I read the routing layer, **I** find one path-based router, not a hash resolver.

| ID | Criterion |
|---|---|
| m-AC-1 | Given `the-hive/src/dashboard/web/router.tsx`, when the migration completes, then `useHashRoute` / `routeFromHash` no longer resolve the active route from `location.hash`; the active route derives from the path served per [`prd-003a`](./prd-003a-route-model-and-server-gate.md). |
| m-AC-2 | Given a browser back/forward navigation, when the migration completes, then navigation operates on real paths (history entries are paths, not fragments) and resolves the same screens. |

### US-2 - preserve every existing page

**As** an operator, **when** I use the dashboard after migration, **I** see every page I had, unchanged.

| ID | Criterion |
|---|---|
| m-AC-3 | Given the pre-migration route set (`/`, `/projects`, `/harnesses`, `/memories`, `/graph`, `/sync`, `/logs`, `/roi`, `/settings`), when the migration completes, then each is reachable at its path and renders the identical page content and data wiring it had under hash routing. |
| m-AC-4 | Given `registry.tsx`, when it is converted, then the route-to-page mapping is preserved one-for-one (no page dropped, renamed away, or merged) apart from the addressing change from hash to path. |
| m-AC-5 | Given `/` after migration, when an authenticated operator with a healthy fleet lands there, then `/` renders the dashboard (consistent with [`prd-003a`](./prd-003a-route-model-and-server-gate.md) g-AC-5), never a blank shell. |

### US-3 - unwind the nested gates

**As** a maintainer, **when** I read `main.tsx`, **I** find the boot no longer nests two React gates that duplicate the server decision.

| ID | Criterion |
|---|---|
| m-AC-6 | Given `the-hive/src/dashboard/web/main.tsx`, when the migration completes, then the `ReadinessSplash`-then-`SetupGate` nested gate tree no longer makes the health/auth landing decision; that decision is the server gate's ([`prd-003a`](./prd-003a-route-model-and-server-gate.md)). |
| m-AC-7 | Given the `ReadinessSplash` concept, when the migration completes, then it is reachable as the `/buzzing` route ([`prd-004`](../prd-004-buzzing-service-loaders/prd-004-buzzing-service-loaders-index.md)) rather than an unconditional pre-mount gate. |
| m-AC-8 | Given `SetupGate`'s device-flow view, when the migration completes, then it is reachable as the `/login` route ([`prd-003b`](./prd-003b-login-route-device-flow.md)) rather than a nested gate branch. |

---

## Implementation notes

### Scope discipline: routing only

The migration touches the routing layer (`router.tsx`, `registry.tsx`, `main.tsx`) and nothing inside the page components. Each page keeps its `wire`-hydrated data path from PRD-001 unchanged; only how the page is addressed and mounted changes. This keeps the migration reviewable as a routing diff, not a page rewrite.

### Relationship to the server gate

Because [`prd-003a`](./prd-003a-route-model-and-server-gate.md) makes the server authoritative for the landing decision, the client no longer needs the `ReadinessSplash` / `SetupGate` gate nesting to protect screens. The client router's job narrows to rendering the screen for the already-authorized path the server served. `/buzzing` and `/login` become ordinary routes in the registry, distinguished only by being the server's gate-exempt destinations.

## Related

- [`prd-003-portal-landing-gate-and-routing-index.md`](./prd-003-portal-landing-gate-and-routing-index.md) - module scope and the route set.
- [`prd-003a-route-model-and-server-gate.md`](./prd-003a-route-model-and-server-gate.md) - the server route model and gate this migration conforms the SPA to.
- [`prd-003b-login-route-device-flow.md`](./prd-003b-login-route-device-flow.md) - the `/login` route `SetupGate`'s view relocates to.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - "server-side, path-based, not client hash" and the migration consequence it names.
- the-hive [`prd-001b-dashboard-migration-and-copy-map`](../../in-work/prd-001-thehive-portal-daemon/prd-001b-dashboard-migration-and-copy-map.md) - the copy-and-own migration that brought this SPA (and its hash router) into thehive.
- the-hive [`prd-002b-readiness-splash-ui`](../../in-work/prd-002-portal-readiness-splash/prd-002b-readiness-splash-ui.md) - the `ReadinessSplash` and `main.tsx` tree-order this migration unwinds into `/buzzing`.
- `the-hive/src/dashboard/web/router.tsx` - `useHashRoute` / `routeFromHash`, retired here.
- `the-hive/src/dashboard/web/registry.tsx` - the route registry converted from hash to path addressing.
- `the-hive/src/dashboard/web/main.tsx` - the boot entry whose nested gates are unwound.
