# PRD-004b: Bee-related status SVG set and status state model

> Parent: [`prd-004-buzzing-service-loaders-index.md`](./prd-004-buzzing-service-loaders-index.md)

## Overview

This sub-PRD owns the visual half of the readiness screen: the bee-related status SVG icon set and the mapping from each status state to its SVG. The status state model itself is locked in the parent index; this sub-PRD makes each state visually legible so an operator glancing at `/buzzing` ([`prd-004a`](./prd-004a-buzzing-screen.md)) can read a service's condition at a glance.

The five states, drawn from the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md)'s requirement that `/buzzing` render per-service loading state, are: `error`, `degraded`, `starting`, `warming`, `active`. Each gets a distinct bee-themed SVG that conveys its meaning without relying on color alone (so the states are distinguishable in dark mode and for color-vision-deficient operators). The derivation from hivedoctor telemetry to these states is [`prd-004c`](./prd-004c-status-derivation.md).

## Goals

- A bee-related SVG for each of the five states, distinct in shape/motif, not color alone.
- A single, shared state-to-SVG mapping so `/buzzing` tiles and any future consumer render the same icon for the same state.
- Icons that read clearly at tile size and remain legible in dark mode.
- A state model documented as the contract [`prd-004c`](./prd-004c-status-derivation.md) derives into and [`prd-004a`](./prd-004a-buzzing-screen.md) renders from.

## Non-Goals

- The rule mapping hivedoctor telemetry to a state - [`prd-004c`](./prd-004c-status-derivation.md).
- The screen layout, tile grid, and lifecycle - [`prd-004a`](./prd-004a-buzzing-screen.md).
- Final art direction, motion choreography, and exact palette tokens beyond legibility and distinctness - an implementation-time `ux-ui-worker-bee` concern; this sub-PRD fixes the state set, the semantics, and the distinctness requirement.
- Icons for the health rail pills on other routes - [`prd-005a`](../prd-005-health-rail-and-page/prd-005a-health-rail.md) may reuse this set, but its pill rendering is that PRD's concern.

---

## Status state model (contract)

| State | Semantic the SVG must convey |
|---|---|
| `error` | Failed or unreachable; needs attention, not expected to self-recover. |
| `degraded` | Up but unhealthy or partially functional. |
| `starting` | Process lifecycle begun; not yet bound or checked in. |
| `warming` | Checked in; initializing / warming, not yet healthy. |
| `active` | Registered, checked in, healthy. |

---

## User stories + acceptance criteria

### US-1 - one SVG per state

**As** an operator, **when** I look at a tile, **I** can tell the service's state from its icon.

| ID | Criterion |
|---|---|
| svg-AC-1 | Given the five states, when the icon set is delivered, then there is a distinct bee-related SVG for each of `error`, `degraded`, `starting`, `warming`, and `active`. |
| svg-AC-2 | Given any two states, when their SVGs are compared, then they are distinguishable by shape or motif, not by color alone (so they read for color-vision-deficient operators and in grayscale). |
| svg-AC-3 | Given a tile at its rendered size, when its SVG displays, then the icon is legible at that size and in dark mode. |

### US-2 - a single shared mapping

**As** a maintainer, **when** I render a state anywhere, **I** use one mapping.

| ID | Criterion |
|---|---|
| svg-AC-4 | Given a status state, when any consumer needs its icon, then it resolves through a single shared state-to-SVG mapping, so `/buzzing` tiles ([`prd-004a`](./prd-004a-buzzing-screen.md)) and any reuse (for example the health rail, [`prd-005a`](../prd-005-health-rail-and-page/prd-005a-health-rail.md)) show the same icon for the same state. |
| svg-AC-5 | Given a state value outside the five, when the mapping is asked to resolve it, then it fails safe to a defined fallback icon rather than rendering nothing, so an unexpected value never produces a blank tile. |

### US-3 - the state set is the contract

**As** [`prd-004c`](./prd-004c-status-derivation.md), **when** I derive a state, **I** target exactly this set.

| ID | Criterion |
|---|---|
| svg-AC-6 | Given the state model, when it is defined, then it enumerates exactly the five states above with their semantics, and [`prd-004c`](./prd-004c-status-derivation.md) derives into this set with no additional or renamed state. |

---

## Implementation notes

### Distinctness over color

Because tiles must remain readable in dark mode and for color-vision-deficient operators, each state's SVG differs in motif (for example a settled bee, a wandering bee, a resting bee) and not only in tint. Color may reinforce state but must never be the sole differentiator (svg-AC-2). This keeps the readiness screen honest under the same dark-mode and no-explicit-color constraints the documentation-framework diagram rules already impose on the repo.

### Reuse by the health rail

The same state set backs the health rail pills in [`prd-005a`](../prd-005-health-rail-and-page/prd-005a-health-rail.md). Keeping the state-to-SVG mapping single-sourced (svg-AC-4) means a service shown `warming` on `/buzzing` and `warming` on the rail uses the identical icon, so operators learn one visual vocabulary.

## Related

- [`prd-004-buzzing-service-loaders-index.md`](./prd-004-buzzing-service-loaders-index.md) - the locked state model this sub-PRD visualizes.
- [`prd-004a-buzzing-screen.md`](./prd-004a-buzzing-screen.md) - the screen that renders these SVGs per tile.
- [`prd-004c-status-derivation.md`](./prd-004c-status-derivation.md) - the derivation that produces the state each SVG represents.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the requirement that `/buzzing` render per-service loading state.
- the-hive [`prd-005a-health-rail`](../prd-005-health-rail-and-page/prd-005a-health-rail.md) - the rail that reuses this state-to-icon vocabulary.
