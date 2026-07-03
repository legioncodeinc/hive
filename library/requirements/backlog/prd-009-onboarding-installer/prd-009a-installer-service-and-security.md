# PRD-009a: Installer service and security

> Parent: [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md)

## Overview

The browser cannot run npm; the daemon can. This sub-PRD adds an installer service to the hive daemon (`src/daemon/server.ts` tier, alongside the BFF proxy and the fleet-status route): endpoints for detection (what is installed), starting a per-product install, streaming install progress over SSE, running the health check, and serving the login step. Post-install registration reuses each product's own registration verb exactly as `install.sh` does today (`doctor install-service`, `honeycomb install`, `nectar install`), preserving the one-registry-writer-per-product invariant that `src/install/registry.ts` establishes for hive itself.

An endpoint on `127.0.0.1:3853` that shells out to `npm install` is a drive-by target: any web page the operator visits can fire a `fetch` or form POST at a loopback port. Three mitigations are therefore non-negotiable acceptance criteria, not implementation suggestions: a hard product-slug allowlist with server-side `packageName@version` resolution from `hive-release.json`, Origin and Host validation rejecting non-portal origins, and a one-time onboarding token minted by the bootstrap script and required on every installer endpoint. On top of those, npm must be invoked as an argv array (`spawn` semantics), never via a shell string that could interpolate request data.

## Goals

- The daemon exposes the five installer surfaces: detection, install start (per product), SSE install progress, health check, and the login step (the last reusing the existing `/setup/*` proxy).
- Install requests carry only a product slug; the daemon resolves what to install (`packageName@version`) from the pinned fleet manifest, server-side.
- The three security mitigations hold on every installer endpoint, and npm child-process invocation is structurally injection-free.
- Progress is staged and observable (resolving, downloading, linking, registering service), derived from real signals, never a synthesized percentage.
- Install state is idempotent and resumable: an installed product is never re-run, a failed product is retryable, and concurrent duplicate requests do not double-install.

## Non-Goals

- The onboarding UI that consumes these endpoints - that is [`prd-009b`](./prd-009b-onboarding-route-and-guided-flow.md).
- Telemetry emission - the funnel events are [`prd-009c`](./prd-009c-onboarding-telemetry.md); this sub-PRD only exposes the state transitions those events are derived from.
- The bootstrap script's token mint and handoff - that is [`prd-009d`](./prd-009d-thin-bootstrap-companion.md); this sub-PRD defines the daemon's side of the token contract.
- Uninstall, downgrade, or version-switch endpoints - out of scope per the parent's non-goals.
- Any non-loopback exposure - the daemon keeps its existing `127.0.0.1` bind; nothing here changes listening behavior.

---

## User stories + acceptance criteria

### US-1 - detection

**As** the onboarding UI, **when** I load, **I** learn which fleet products are installed without requiring doctor to exist yet.

| ID | Criterion |
|---|---|
| is-AC-1 | Given a fresh machine with only hive installed, when the detection endpoint is called, then it reports hive as installed and Doctor, Honeycomb, and Nectar as not installed, without depending on doctor's status page being reachable (fleet-status alone cannot answer this pre-doctor). |
| is-AC-2 | Given a machine with some or all products installed, when detection runs, then each product reports one of a closed state set (at minimum: not_installed, installed, install_in_progress, install_failed) plus the installed version when known, and the response is derived from local evidence (global npm resolution and/or each product's registration artifacts), not from the request. |

### US-2 - allowlisted, manifest-pinned install

**As** the operator, **when** the portal installs a product, **only** the four known products at their fleet-pinned versions can ever be installed.

| ID | Criterion |
|---|---|
| is-AC-3 | Given the install endpoint, when the request body names anything other than one of the four product slugs (`honeycomb`, `doctor`, `hive`, `nectar`), then the request is rejected with a 4xx and no child process is spawned. |
| is-AC-4 | Given an allowlisted slug, when the daemon starts the install, then it resolves `packageName@version` server-side from `hive-release.json` (per-product keys carrying `packageName`, `version`, `published`), and no package name, version, registry URL, or npm argument is ever taken from the request. |
| is-AC-5 | Given the manifest, when a product's `published` flag is false or the manifest cannot be resolved at all, then the install for that product is refused with an honest error rather than falling back to an unpinned `npm i -g <name>@latest`. |
| is-AC-6 | Given the npm invocation, when audited, then the child process is spawned with an argv array and `shell` disabled; no code path concatenates request-derived data into a shell string. |

### US-3 - origin, host, and token gating

**As** the fleet's security posture, **when** any page other than the portal tries to reach the installer, **it** is rejected.

| ID | Criterion |
|---|---|
| is-AC-7 | Given any installer endpoint (detection, install, progress, health, login step), when the request carries an `Origin` header that is not the portal's own origin (`http://127.0.0.1:3853`), then it is rejected with a 403; a missing `Origin` on a state-changing (non-GET) request is also rejected. |
| is-AC-8 | Given any installer endpoint, when the `Host` header is not the portal's own host, then the request is rejected (DNS-rebinding defense: a rebound hostname resolving to 127.0.0.1 fails the Host check even though the socket is loopback). |
| is-AC-9 | Given the one-time onboarding token minted by the bootstrap ([`prd-009d`](./prd-009d-thin-bootstrap-companion.md)) and embedded in the opened URL (`/onboarding?t=...`), when an installer endpoint is called without a valid token, then it is rejected with a 401; the token is single-session (invalidated when onboarding completes) and is compared in constant time. |
| is-AC-10 | Given a fully-onboarded machine (all products installed, onboarding completed), when the token has been invalidated, then state-changing installer endpoints refuse all requests until a new token is minted by a fresh bootstrap run; read-only detection may remain available to the portal for the re-entry short-circuit. |

### US-4 - staged, streamed progress

**As** the onboarding UI, **when** an install runs, **I** receive honest staged progress over SSE.

| ID | Criterion |
|---|---|
| is-AC-11 | Given a started install, when the UI subscribes to the progress stream, then progress arrives as SSE events following the same relay discipline as `src/daemon/telemetry-proxy.ts` (same-origin, body-to-body semantics, no unbounded buffering), and each event names a stage from a closed set (at minimum: resolving, downloading, linking, registering_service, completed, failed). |
| is-AC-12 | Given npm's lack of a native percentage, when progress is rendered, then the stream never fabricates a percent-complete value; stages are derived from observable child-process signals (spawn, npm output milestones, exit code, registration verb start/exit). |
| is-AC-13 | Given a completed npm install for a product, when the daemon proceeds, then it runs that product's own registration verb (`doctor install-service`, `honeycomb install`, `nectar install`) exactly as `install.sh` does today, and the registering_service stage covers this step; a registration failure marks the product install failed, never silently succeeded. |
| is-AC-14 | Given a mid-install browser disconnect, when the SSE consumer goes away, then the install itself continues to its terminal state, and a re-subscribed client receives the current stage (the stream is resumable against daemon-held state, not coupled to one browser tab's lifetime). |

### US-5 - idempotency and failure honesty

**As** the operator, **when** I retry or revisit, **the** installer never lies and never double-installs.

| ID | Criterion |
|---|---|
| is-AC-15 | Given a product already installed at the pinned version, when an install is requested for it, then the daemon short-circuits to completed without spawning npm. |
| is-AC-16 | Given two concurrent install requests for the same product, when they race, then exactly one child process runs; the second request attaches to the in-progress install's state rather than spawning a duplicate. |
| is-AC-17 | Given a failed install, when the state is read, then it carries the failure stage and a truthful error summary (exit code and a bounded stderr excerpt), and a subsequent install request for that product is permitted as a retry. |

### US-6 - health check and login step

**As** the onboarding flow, **when** installs finish, **I** can verify the fleet and complete the Deeplake login through existing surfaces.

| ID | Criterion |
|---|---|
| is-AC-18 | Given the post-install health check, when invoked, then it reuses the existing readiness projection (`fetchFleetStatus` / `isFleetReady`, `src/daemon/fleet-status.ts`) against doctor's status page rather than re-deriving health, and reports per-daemon health for the green-light view. |
| is-AC-19 | Given the login step, when the flow reaches it, then the device flow runs through the existing proxied `POST /setup/login` and `GET /setup/state` surfaces (ADR-0002 posture); hive stores no credential and no token field crosses the wire, unchanged from PRD-003b. |

---

## Implementation notes

### Where the service lives

The installer service is daemon-side Hono routes registered in `src/daemon/server.ts`, before the generic `/api/*` BFF proxy (the same registration-order discipline as `/api/fleet-status` and `/api/telemetry/stream`). The portal gate (`src/daemon/gate.ts`) must treat the installer API paths as data-plane infra (they already fall under the `/api/` exempt prefix) and add `/onboarding` to `GATE_EXEMPT_ROUTES` so the page itself is reachable pre-health and pre-auth.

### Manifest resolution

`hive-release.json` is the single version authority. The daemon fetches the raw manifest at onboarding start and holds it for the session; a bundled build-time snapshot is the fallback when the network fetch fails, so an offline-ish first run can still pin versions (the snapshot is the version set the running hive shipped with). The refusal path (is-AC-5) exists so a malformed or unreachable manifest can never degrade into installing `@latest`.

### Token contract (daemon side)

The bootstrap mints the token and hands it to the daemon out-of-band from the browser (the natural seam: a file under `~/.honeycomb/hive/` at mode `0600`, written before the daemon starts, or a daemon start argument; the file is the suggested form since the daemon may already be running on re-entry). The daemon loads it at startup, requires it on installer endpoints (is-AC-9), and invalidates it when onboarding reaches its terminal state (is-AC-10). The token never appears in logs or telemetry.

### One registry writer per product

hive writes only its own doctor-registry entry (`src/install/registry.ts`). The installer service never writes another product's registration; it invokes that product's verb and lets the product register itself, exactly the handoff `install.sh` performs today. This keeps registration ownership where each product's code already maintains it.

## Related

- [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md) - module scope, the locked bootstrap-then-portal direction, and the security non-negotiables.
- [`prd-009b-onboarding-route-and-guided-flow.md`](./prd-009b-onboarding-route-and-guided-flow.md) - the UI consuming these endpoints.
- [`prd-009d-thin-bootstrap-companion.md`](./prd-009d-thin-bootstrap-companion.md) - the token mint and handoff on the bootstrap side.
- [`trust-boundaries`](../../../knowledge/private/security/trust-boundaries.md) - the loopback trust model these mitigations defend.
- `src/daemon/telemetry-proxy.ts` - the SSE relay pattern the progress stream mirrors.
- `src/daemon/fleet-status.ts` - `fetchFleetStatus` / `isFleetReady`, reused by the health check.
- `src/daemon/gate.ts` - `GATE_EXEMPT_ROUTES` and the `/api/` infra prefix the installer surfaces slot into.
- `src/install/registry.ts` - hive's own registration writer, the per-product-ownership precedent.
- honeycomb `scripts/install/install.sh` - the registration-verb handoff being reused (`doctor install-service`, `honeycomb install`, `nectar install`).
- `../../../../../hive-release.json` - the pinned fleet manifest resolved server-side.
