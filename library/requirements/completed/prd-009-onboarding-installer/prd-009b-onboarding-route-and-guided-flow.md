# PRD-009b: Onboarding route and guided flow

> Parent: [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md)

## Overview

This sub-PRD delivers the operator-facing `/onboarding` experience: visual fleet detection, a polished first-run hero with an animated entrance of the product brand SVGs (`assets/brand/`, `assets/logos/`), the two-choice Standard/Advanced entry, the guided per-product install cards, the green-light health check, the Deeplake device-code login step, and the final drop onto the dashboard. Presentation quality is an explicit requirement of this flow, not a nice-to-have: this screen is the first thing every new operator sees, and the direction is that it must present well.

The flow consumes the installer service from [`prd-009a`](./prd-009a-installer-service-and-security.md) (detection, install start, SSE progress, health, login) and carries the one-time onboarding token from the opened URL (`/onboarding?t=...`) on every installer call. It also closes a known gap: the onboarding login step must display the Deeplake device-code (`user_code`) and verification link on screen, reusing the grant-display contract that `src/dashboard/web/setup-gate.tsx` (`GuidedSetup`) defines, so the operator always sees the code they need to enter.

## Goals

- `/onboarding` renders pre-health and pre-auth (gate-exempt) and opens with detection, so what the operator sees always reflects what is actually installed.
- A first-run machine (only hive detected) gets the animated hero and exactly two choices with the verbatim copy specified below.
- Each remaining product installs behind a full-screen card with logo, title, benefit copy, staged progress, npm-safety copy, and a minimum dwell of ~30 seconds.
- The post-install sequence is health check (green-light style), then the device-code login display, then the dashboard, with no dead ends.
- Re-entry is idempotent and honest: installed products are never re-run, failures show the real error with a retry, and a fully-healthy machine short-circuits past onboarding.

## Non-Goals

- The daemon endpoints, security gating, and npm mechanics - [`prd-009a`](./prd-009a-installer-service-and-security.md).
- The funnel telemetry - [`prd-009c`](./prd-009c-onboarding-telemetry.md); this sub-PRD defines the user-visible transitions those events mark.
- The bootstrap's browser open and printed fallback line - [`prd-009d`](./prd-009d-thin-bootstrap-companion.md).
- The device-flow protocol itself - honeycomb owns `/setup/login` and `/setup/state`; this flow reuses them through the proxy unchanged.
- Redesigning `/login` for the returning-operator path - PRD-003b owns that route; this sub-PRD embeds the same grant display inside onboarding.

---

## User stories + acceptance criteria

### US-1 - entry and detection

**As** a new operator, **when** the bootstrap opens my browser, **I** land on a screen that already knows what is installed.

| ID | Criterion |
|---|---|
| ob-AC-1 | Given the URL `http://127.0.0.1:3853/onboarding` (with the token query parameter), when the fleet is unhealthy and the operator unauthenticated (the guaranteed first-run state), then the page renders rather than redirecting: `/onboarding` is gate-exempt in `src/daemon/gate.ts` alongside `/buzzing` and `/login`. |
| ob-AC-2 | Given page load, when detection resolves, then the UI reflects the daemon's detection response ([`prd-009a`](./prd-009a-installer-service-and-security.md) is-AC-1/is-AC-2) and never assumes a product set client-side. |
| ob-AC-3 | Given a machine where all four products are installed and the fleet is healthy, when `/onboarding` is visited, then no install is offered or run; the flow short-circuits to the dashboard (or a brief "fleet healthy" summary that links to it). |

### US-2 - first-run hero and the two choices

**As** a first-run operator, **when** only hive is detected, **I** get a polished welcome and one simple decision.

| ID | Criterion |
|---|---|
| ob-AC-4 | Given first run, when the hero renders, then each product's brand SVG enters with a deliberate animation (assets from `assets/brand/` and `assets/logos/`; exact choreography is an open question in the parent index, but a static unanimated logo row does not satisfy this criterion). |
| ob-AC-5 | Given the hero, when the choices render, then there are exactly two: a button labeled `Standard User` with subtext `Install the fleet (recommended)`, and a button labeled `Advanced User` with subtext `Custom installation`, both verbatim. |
| ob-AC-6 | Given the Standard choice, when selected, then the guided flow installs all remaining products (Doctor, Honeycomb, Nectar) in a fixed order with no further questions. |
| ob-AC-7 | Given the Advanced choice, when selected, then a product picker lists the remaining products for selection, and confirming the selection enters the same guided per-product flow for exactly the chosen products. |

### US-3 - the guided install cards

**As** the operator, **when** each product installs, **I** see a full-screen card that explains, reassures, and shows honest progress.

| ID | Criterion |
|---|---|
| ob-AC-8 | Given a product install, when its card renders, then it is full-screen and contains the product logo, the product title, and benefit copy explaining why that product helps the operator. |
| ob-AC-9 | Given the card's progress indicator, when the install runs, then progress renders the staged states from the SSE stream (resolving, downloading, linking, registering service) and never renders a percentage bar (npm provides no native percentage; a fake one is prohibited). |
| ob-AC-10 | Given the card copy, when displayed, then it includes a short explanation that installing through npm is safe and why: the packages are signed and provenance-verified on the public registry (all four packages publish with npm Trusted Publishing OIDC provenance, so the claim is checkably true). |
| ob-AC-11 | Given a product whose npm install finishes in under ~30 seconds, when the card would advance, then it holds until a minimum dwell of ~30 seconds has elapsed; given an install that runs longer, the card simply stays until the install reaches a terminal state. The dwell timer never masks a failure: a failed install may surface its error before the 30 seconds elapse. |
| ob-AC-12 | Given a product install failure, when the card updates, then it shows the truthful error summary from the daemon ([`prd-009a`](./prd-009a-installer-service-and-security.md) is-AC-17) and a retry affordance, and never renders a success state for a failed product. |

### US-4 - health check, device-code login, dashboard

**As** the operator, **when** installs complete, **I** watch the fleet come up green, complete the Deeplake login with a visible code, and land on my dashboard.

| ID | Criterion |
|---|---|
| ob-AC-13 | Given all selected installs completed, when the health step renders, then it shows a green-light style per-daemon health view driven by the health check ([`prd-009a`](./prd-009a-installer-service-and-security.md) is-AC-18), and advances only when the required fleet reads ready. |
| ob-AC-14 | Given the login step, when the device flow grant arrives, then the screen displays the Deeplake device-code (`user_code`) prominently plus the verification link (`verification_uri_complete` falling back to `verification_uri`), the same wire contract `GuidedSetup` in `src/dashboard/web/setup-gate.tsx` renders. The code display is a hard requirement of this flow: the operator can never be asked to verify without seeing the code. |
| ob-AC-15 | Given a completed login (the proxied `/setup/state` `authenticated` bit flips true), when the flow advances, then the operator lands on the dashboard immediately via a hard navigation to `/` so the server gate revalidates and serves the authoritative screen (the PRD-003b discipline). |

### US-5 - re-entry and resumability

**As** an operator who closed the tab or hit a failure, **when** I come back, **the** flow resumes honestly.

| ID | Criterion |
|---|---|
| ob-AC-16 | Given a partially-installed machine (some products completed, one failed or pending), when `/onboarding` is revisited, then detection reconstructs the true state: completed products show as installed and are not re-run, a failed product shows its error and retry, and the flow resumes from the first incomplete step. |
| ob-AC-17 | Given a mid-install page refresh, when the page reloads, then the UI re-attaches to the in-progress install's stream ([`prd-009a`](./prd-009a-installer-service-and-security.md) is-AC-14) rather than starting a duplicate install. |

---

## Implementation notes

### Route placement

`/onboarding` is a page route in the SPA served by hive, added to the route model established by PRD-003 and to the gate's exemption set. The token query parameter is read client-side and attached to installer API calls; it should be moved out of the visible URL after first read (for example via `history.replaceState`) so casual screen-sharing does not expose it, while the page keeps it in memory for the session.

### Detection versus fleet-status

`/api/fleet-status` answers "is the installed fleet healthy" and depends on doctor. The onboarding entry state needs "what is installed at all", which must work before doctor exists; that is the detection endpoint from [`prd-009a`](./prd-009a-installer-service-and-security.md). The health step (ob-AC-13) is where the flow converges back onto the existing `isFleetReady` projection.

### Presentation assets

`assets/brand/` carries `hive-mark.svg`, wordmarks, and partner logos; `assets/logos/` carries `honeycomb-memory-cluster.svg`. Doctor and Nectar entrance art must come from their product assets or be added; the acceptance criteria require each product's logo on its card and in the hero, so missing marks are a work item, not a reason to degrade the design.

## Related

- [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md) - module scope and the open questions on animation treatment and picker layout.
- [`prd-009a-installer-service-and-security.md`](./prd-009a-installer-service-and-security.md) - the endpoints, token contract, and progress stages this UI consumes.
- [`prd-009c-onboarding-telemetry.md`](./prd-009c-onboarding-telemetry.md) - the funnel events marking this flow's transitions.
- hive [`prd-003-portal-landing-gate-and-routing`](../prd-003-portal-landing-gate-and-routing/prd-003-portal-landing-gate-and-routing-index.md) - the route model and gate `/onboarding` joins, and the login-completion navigation discipline.
- `src/dashboard/web/setup-gate.tsx` - `GuidedSetup`'s grant display (`user_code`, verification link) the login step reuses.
- `src/daemon/gate.ts` - `GATE_EXEMPT_ROUTES`, where `/onboarding` is added.
- `assets/brand/`, `assets/logos/` - the brand SVGs the hero and cards animate.
