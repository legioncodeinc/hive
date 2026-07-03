# PRD-009c: Onboarding telemetry

> Parent: [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md)

## Overview

This sub-PRD defines the PostHog funnel for the onboarding flow. Today install telemetry fires from the bootstrap shell script (events `install_started`, `install_completed`/`install_failed`, `product_installed`/`updated`/`removed`, with the public project key baked at site build time). Because the human path moves into the portal, the browser-based funnel replaces/augments the script's install-time telemetry for that path; the script keeps its events for CI and headless flag installs, which PRD-009 does not touch.

**Decision: events fire daemon-side, through one chokepoint.** The portal could emit from the browser or from the daemon; this PRD chooses the daemon, for three reasons grounded in the fleet's existing posture. First, hive already has exactly one audited telemetry egress (`emitTelemetry` in `src/telemetry/emit.ts`, documented in [`telemetry-egress`](../../../knowledge/private/telemetry/telemetry-egress.md)) with the build-baked key, the opt-out gates (`HONEYCOMB_TELEMETRY=0`, `DO_NOT_TRACK`), the closed property allow-list, and the fail-soft bounded POST; a browser-side emitter would be a second egress path needing all of that re-implemented and re-audited. Second, the states that matter (install started, completed, failed, health passed, credential landed) are daemon truths; emitting where the state transition happens cannot desynchronize from what actually occurred, whereas a browser tab can close mid-install while the install completes. Third, opt-out is an environment contract on the machine; the daemon can honor `DO_NOT_TRACK` uniformly, while a browser context cannot see it. The two purely-presentational events (`mode_selected`, `login_shown`) are still reported by the UI, but as calls to the daemon which then emits, so every byte still leaves through the one chokepoint.

## Goals

- The full funnel event list emits at the correct transitions, once each per onboarding run (per product where applicable).
- Every event honors the fleet posture: anonymous install id (`~/.honeycomb/install-id`, the shared id the honeycomb installer writes, falling back to hive's own), no PII, fail-soft (a telemetry failure never affects the install), key baked at build, silent no-op when keyless.
- The event property set stays inside a closed allow-list, extending the existing five-key discipline (`package`, `version`, `os`, `arch`, `node`) with only the funnel-specific keys named below.

## Non-Goals

- Changing the shell script's telemetry - `install.sh` keeps `install_started`/`install_completed`/`install_failed` and the per-product transitions for the non-human paths.
- Session replay, autocapture, or any browser-SDK PostHog integration - the portal does not load a PostHog client; emission is daemon-side.
- New opt-out surfaces - the existing `HONEYCOMB_TELEMETRY=0` / `DO_NOT_TRACK` contract governs, unchanged.

---

## User stories + acceptance criteria

### US-1 - the funnel events

**As** the product team, **when** operators onboard, **I** can see where the funnel converts and where it drops.

| ID | Criterion |
|---|---|
| tm-AC-1 | Given an onboarding session, when its milestones occur, then exactly these events emit at these transitions: `onboarding_started` (first `/onboarding` render with a valid token), `mode_selected` with property `mode` of `standard` or `advanced`, `product_install_started` / `product_install_completed` / `product_install_failed` per product with property `product` (the slug), `health_check_passed` (the health step reads ready), `login_shown` (the device-code grant is displayed), `login_completed` (the `authenticated` bit flips true), and `dashboard_reached` (the post-login navigation lands). |
| tm-AC-2 | Given the per-product events, when a product is retried after failure, then a new `product_install_started` / terminal pair may emit for the retry; non-product funnel milestones (`onboarding_started`, `health_check_passed`, `login_completed`, `dashboard_reached`) emit at most once per onboarding session. |

### US-2 - posture compliance

**As** the fleet's privacy posture, **when** any funnel event emits, **it** is anonymous, allow-listed, and fail-soft.

| ID | Criterion |
|---|---|
| tm-AC-3 | Given any funnel event, when it emits, then it flows through the single daemon-side chokepoint (the `src/telemetry/emit.ts` discipline: build-baked public key, silent no-op when the key is absent, `HONEYCOMB_TELEMETRY=0` / `DO_NOT_TRACK` honored, bounded fail-soft POST that never changes install behavior or exit codes). |
| tm-AC-4 | Given the event payloads, when audited, then properties come from a closed allow-list only: the existing `package`, `version`, `os`, `arch`, `node`, plus `mode` (standard|advanced), `product` (one of the four slugs), and a failure-stage discriminator on `product_install_failed`; never an error string, path, hostname, or any free-form request-derived value. The `distinct_id` is the anonymous shared install id, never an account identifier. |
| tm-AC-5 | Given the one-time onboarding token, when telemetry is inspected, then the token value appears in no event, property, or log line. |

### US-3 - relationship to the script funnel

**As** an analyst, **when** I read the combined data, **the** human and headless paths are distinguishable and not double-counted.

| ID | Criterion |
|---|---|
| tm-AC-6 | Given the thin bootstrap ([`prd-009d`](./prd-009d-thin-bootstrap-companion.md)), when it runs the human path, then per-product install telemetry for Doctor/Honeycomb/Nectar comes from the portal funnel (the script no longer installs them on this path); the script's own events continue to describe only what the script itself did. Both use the same shared anonymous install id so the funnel joins across the handoff. |

---

## Implementation notes

The natural emit points are the daemon-side state transitions [`prd-009a`](./prd-009a-installer-service-and-security.md) already tracks (install start, terminal stage, health pass, `authenticated` flip observed via the existing `/setup/state` read). `mode_selected` and `login_shown` and `dashboard_reached` originate in the UI; the UI reports them to the daemon over the token-gated installer API, and the daemon emits. Dedupe for the once-per-session events can reuse the ledger pattern from `~/.honeycomb/hive/telemetry.json` keyed by onboarding session rather than machine lifetime.

## Related

- [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md) - module scope and the telemetry acceptance criterion.
- [`prd-009a-installer-service-and-security.md`](./prd-009a-installer-service-and-security.md) - the daemon state transitions the events are derived from.
- [`prd-009d-thin-bootstrap-companion.md`](./prd-009d-thin-bootstrap-companion.md) - the script whose install-time telemetry the portal funnel replaces on the human path.
- [`telemetry-egress`](../../../knowledge/private/telemetry/telemetry-egress.md) - the chokepoint, gates, allow-list, ledger, and bounded POST this funnel extends.
- `src/telemetry/emit.ts` - the single egress module the funnel events flow through.
- honeycomb `scripts/install/install.sh` - the existing script-side funnel (`install_started`, `install_completed`/`install_failed`, per-product transitions) this augments.
