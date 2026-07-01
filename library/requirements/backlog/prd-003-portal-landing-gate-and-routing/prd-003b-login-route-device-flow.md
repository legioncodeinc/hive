# PRD-003b: `/login` route and device-flow reuse

> Parent: [`prd-003-portal-landing-gate-and-routing-index.md`](./prd-003-portal-landing-gate-and-routing-index.md)

## Overview

This sub-PRD delivers the `/login` route and the "logged in" determination the gate depends on, per the-hive [`ADR-0004`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md). `/login` renders the **existing device-flow guided setup**, reusing honeycomb's `/setup/login` through thehive's BFF proxy ([`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md), `the-hive/src/daemon/proxy.ts`). It is the same device flow the current `SetupGate` (`the-hive/src/dashboard/web/setup-gate.tsx`) drives, now addressable as its own path.

"Logged in" is not a new portal session. It is credential presence: the `authenticated` bit that honeycomb's proxied `GET /setup/state` returns, which is true exactly when a valid `~/.deeplake/credentials.json` exists. ADR-0004 rejects introducing a portal-specific session; this sub-PRD keeps that single, shared source of truth.

## Goals

- `/login` is a real, gate-exempt route that renders the existing device-flow guided setup via the proxied honeycomb `/setup/login`.
- The gate's auth step reads exactly one signal: the proxied `/setup/state` `authenticated` bit; no portal session or portal credential is created.
- Completing the device flow flips `authenticated` to true, after which the gate ([`prd-003a`](./prd-003a-route-model-and-server-gate.md)) stops redirecting to `/login` and serves the dashboard.
- thehive remains credential-free: it stores nothing, it passes the device flow through transparently.

## Non-Goals

- The device-flow protocol itself (polling cadence, code exchange, token storage) - honeycomb owns `/setup/login` and `/setup/state`; this sub-PRD reuses them unchanged through the proxy.
- The gate precedence and redirect logic - that is [`prd-003a`](./prd-003a-route-model-and-server-gate.md); this sub-PRD supplies the auth input it consumes and the destination it redirects to.
- Retiring `SetupGate` as a React component vs re-hosting its device-flow view under `/login` - a migration detail owned by [`prd-003c`](./prd-003c-hash-to-path-migration.md); this sub-PRD requires only that the `/login` route shows the same guided setup.

---

## User stories + acceptance criteria

### US-1 - `/login` renders the existing device flow

**As** a logged-out operator, **when** I am sent to `/login`, **I** see the same guided setup I see today, at its own path.

| ID | Criterion |
|---|---|
| l-AC-1 | Given a landing on `/login`, when thehive serves it, then the route renders the existing device-flow guided setup, sourced from honeycomb's `/setup/login` through the BFF proxy (`the-hive/src/daemon/proxy.ts`), not a reimplemented flow. |
| l-AC-2 | Given `/login`, when it drives the device flow, then all `/setup/*` traffic goes same-origin to thehive, which proxies it to honeycomb over loopback; the browser never contacts honeycomb directly. |
| l-AC-3 | Given `/login` is gate-exempt ([`prd-003a`](./prd-003a-route-model-and-server-gate.md) g-AC-8), when a logged-out operator lands there, then it is served directly and does not redirect. |

### US-2 - logged-in determination via `/setup/state`

**As** the gate, **when** I decide auth, **I** read one shared bit, not a portal session.

| ID | Criterion |
|---|---|
| l-AC-4 | Given the gate's auth step, when it determines "logged in", then it reads the proxied honeycomb `GET /setup/state` `authenticated` bit and treats true as logged in, false as logged out. |
| l-AC-5 | Given ADR-0004's rejection of a portal session, when the auth determination is audited, then thehive creates, stores, or reads no portal-specific cookie or session; credential presence via `/setup/state` is the sole source of truth. |
| l-AC-6 | Given the proxied `/setup/state` fetch fails or times out, when the gate evaluates auth, then it treats the operator as not logged in (redirect to `/login`), never fail-soft into the dashboard. |

### US-3 - completing setup dismisses `/login`

**As** an operator finishing setup, **when** the credential is written, **I** land on the dashboard without a manual retry.

| ID | Criterion |
|---|---|
| l-AC-7 | Given a successful device-flow completion that writes a valid `~/.deeplake/credentials.json`, when `/setup/state` subsequently reports `authenticated: true`, then the gate ([`prd-003a`](./prd-003a-route-model-and-server-gate.md)) no longer redirects to `/login` and serves the requested route (defaulting to `/`). |
| l-AC-8 | Given completion on `/login`, when auth flips to true, then the operator reaches the dashboard at `/` (or their originally requested route if preserved) without being trapped on `/login`. |

---

## Implementation notes

### Reuse, do not reimplement

`/login` re-hosts the device-flow view that `SetupGate` (`the-hive/src/dashboard/web/setup-gate.tsx`) already renders, pointed at the same proxied `/setup/login`. The behavioral contract is unchanged; only the addressing changes (a path instead of a nested React gate). This keeps honeycomb the single owner of the device-flow protocol and thehive a transparent pass-through per ADR-0002.

### One definition of "logged in"

The gate and any client code both read the `authenticated` bit from the proxied `/setup/state`. There is deliberately no second notion of authentication for thehive to store or keep in sync, which is the ADR-0004 rationale for reusing the Deep Lake credential rather than inventing a portal session. A proxy failure resolves to "not authenticated" so the failure mode is `/login`, the safe direction.

## Related

- [`prd-003-portal-landing-gate-and-routing-index.md`](./prd-003-portal-landing-gate-and-routing-index.md) - module scope and precedence.
- [`prd-003a-route-model-and-server-gate.md`](./prd-003a-route-model-and-server-gate.md) - the gate that consumes the `authenticated` bit and redirects here.
- [`prd-003c-hash-to-path-migration.md`](./prd-003c-hash-to-path-migration.md) - the migration that re-hosts `SetupGate`'s view under `/login`.
- [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - "reuse the Deep Lake credential, do not invent a portal session" and the `/login` exemption.
- [`ADR-0002-server-side-bff-proxy-for-dashboard-federation`](../../../knowledge/private/architecture/ADR-0002-server-side-bff-proxy-for-dashboard-federation.md) - the proxy `/login` and the auth read ride over.
- the-hive [`prd-001c-api-aggregation-wire`](../../in-work/prd-001-thehive-portal-daemon/prd-001c-api-aggregation-wire.md) - the federated proxy and loopback trust model `/setup/*` reuse.
- `the-hive/src/dashboard/web/setup-gate.tsx` - the current device-flow gate whose view `/login` re-hosts.
- `the-hive/src/daemon/proxy.ts` - the BFF proxy `/setup/login` and `/setup/state` pass through.
