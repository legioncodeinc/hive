# PRD-002a: Fleet status proxy

> Parent: [`prd-002-portal-readiness-splash-index.md`](./prd-002-portal-readiness-splash-index.md)

## Overview

This sub-PRD delivers thehive's server-side `GET /api/fleet-status` route: a loopback-only fetch of hivedoctor's status page (`http://127.0.0.1:3852/status.json`), reshaped into a fail-soft payload the browser can gate on. It is the server half of Option B (locked in the pinned note [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md)): thehive never probes workload daemons directly; it reads hivedoctor's supervision truth and forwards it, the same posture `GET /api/daemon-bases` (`src/daemon/server.ts:72`) already has for the federated `wire`'s routing table.

The route sits beside the existing `/health` and `/api/daemon-bases` routes in `src/daemon/server.ts` (`createThehive`, `src/daemon/server.ts:55-80`), and reuses the loopback-trust primitives PRD-001's security remediation introduced (`isLoopbackBaseUrl`, `src/shared/daemon-routing.ts:32-38`; the rejection pattern in `baseUrlFromHealthUrl`, `src/daemon/registry.ts:30-46`) rather than inventing a new trust model.

## Goals

- `GET /api/fleet-status` on thehive's own server fetches hivedoctor's status page over loopback only and returns a normalized, fail-soft payload.
- hivedoctor being unreachable produces a distinct, honest `supervisor: "unreachable"` result - never an exception, never a payload that could be mistaken for "fleet ready."
- A single `isFleetReady()` predicate encodes the v1 gating rule (aggregate `health === "ok"` AND every v1-required peer's row is `health === "ok"`) so the browser never re-derives readiness from raw fields.
- The hivedoctor origin is hard-pinned to loopback; a non-loopback or tampered value can never be used to fetch fleet status, mirroring the `daemon-bases` security fix.

## Non-Goals

- The `ReadinessSplash` component that consumes this endpoint and its polling cadence - that is [`prd-002b`](./prd-002b-readiness-splash-ui.md).
- hivedoctor's own status-page implementation, its `daemons[]` schema, or its escalation model - owned by hivenectar [`prd-004b`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md); this sub-PRD consumes that contract as a given (see the parent index's "Dependency status").
- Any change to `GET /api/daemon-bases` or the federated `wire`'s endpoint-owner routing (`src/shared/daemon-routing.ts`) - unrelated data path, referenced here only for its trust-model precedent.
- Caching or debouncing the upstream fetch beyond what the browser's own poll interval already provides ([`prd-002b`](./prd-002b-readiness-splash-ui.md) owns the poll cadence).

---

## User stories + acceptance criteria

### US-1 - loopback-only proxy route

**As** the browser, **when** I need fleet health, **I** ask thehive's own server, never hivedoctor directly.

| ID | Criterion |
|---|---|
| fs-AC-1 | Given thehive's server (`src/daemon/server.ts`, alongside `/health` and `/api/daemon-bases`), when a client requests `GET /api/fleet-status`, then thehive's server fetches `http://127.0.0.1:3852/status.json` over loopback and returns a normalized JSON body; the browser never opens a direct connection to `:3852`. |
| fs-AC-2 | Given the hivedoctor status-page origin, when the route constructs the fetch URL, then the origin is a hard-coded loopback constant (`127.0.0.1:3852`), not derived from any registry file, request input, or environment value that could be tampered with. |

### US-2 - fail-soft when hivedoctor is unreachable

**As** an operator, **when** hivedoctor itself is down, **I** see the splash persist rather than a broken page or a false "ready" signal.

| ID | Criterion |
|---|---|
| fs-AC-3 | Given hivedoctor's `:3852` is down or the fetch throws/times out, when `GET /api/fleet-status` is requested, then thehive returns `{ "supervisor": "unreachable", "daemons": [] }` with a 200 status (a fail-soft body, not a 5xx that would need bespoke browser error handling), matching the pinned note's documented fail-soft shape. |
| fs-AC-4 | Given hivedoctor returns a non-JSON or malformed body, when thehive parses it, then thehive treats the response identically to fs-AC-3 (fail-soft to `supervisor: "unreachable"`) rather than throwing into the route handler. |
| fs-AC-5 | Given hivedoctor is reachable and returns a well-formed status body, when thehive parses it, then the route returns `{ "supervisor": "reachable", "health": ..., "daemons": [...], "asOf": ... }`, passing through hivedoctor's aggregate `health`, its `daemons[]` array (per the [PRD-004b contract](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md)), and `asOf` unchanged. |

### US-3 - the `isFleetReady()` gating rule

**As** the splash, **when** I decide whether to dismiss, **I** apply one shared rule, not ad hoc field checks.

| ID | Criterion |
|---|---|
| fs-AC-6 | Given a fleet-status payload, when `isFleetReady()` evaluates it, then it returns `true` only when `supervisor === "reachable"` AND the aggregate `health === "ok"` AND every v1-required peer name (`["honeycomb"]`, per the parent index's "v1 required peers") has a matching `daemons[]` entry with `health === "ok"`. |
| fs-AC-7 | Given the aggregate `health` is `"degraded"`, `"unreachable"`, or `"unknown"`, when `isFleetReady()` evaluates the payload, then it returns `false` - `degraded` is never treated as ready, matching the pinned note's locked default (no exception for partial health). |
| fs-AC-8 | Given a v1-required peer (`honeycomb`) is missing from `daemons[]` entirely (for example, an older hivedoctor that has not yet registered it, or a payload predating the PRD-004b extension), when `isFleetReady()` evaluates the payload, then it returns `false` rather than treating an absent entry as vacuously satisfied. |

### US-4 - tamper-safety (security)

**As** a security reviewer, **when** I audit `/api/fleet-status`, **I** find it cannot be redirected off loopback.

| ID | Criterion |
|---|---|
| fs-AC-9 | Given the route's implementation, when it is audited, then the hivedoctor fetch target is validated with `isLoopbackBaseUrl()` (`src/shared/daemon-routing.ts:32-38`) before use (defense in depth even though the origin is hard-coded, so a future refactor that parameterizes the origin cannot silently drop the loopback check), mirroring the rejection pattern in `baseUrlFromHealthUrl` (`src/daemon/registry.ts:30-46`). |
| fs-AC-10 | Given a request to `GET /api/fleet-status` from any client, when the route handles it, then thehive never echoes hivedoctor's raw response headers or any upstream error detail (stack trace, upstream URL) into the client-facing body - only the normalized `{ supervisor, health, daemons, asOf }` shape crosses the boundary. |

---

## Implementation notes

### Route placement

`GET /api/fleet-status` is added to `createThehive` (`src/daemon/server.ts:55-80`) alongside the existing `app.get("/health", ...)` (`:64-70`) and `app.get("/api/daemon-bases", ...)` (`:72`). It requires no new dependency beyond a `fetch` call (Node's global `fetch`, already implicitly available in the runtime `@hono/node-server` targets) and, per fs-AC-9, an explicit `isLoopbackBaseUrl()` guard on the constructed URL before the fetch fires.

### Fail-soft payload shape

Two response shapes, discriminated by `supervisor`:

```ts
type FleetStatusResponse =
  | {
      supervisor: "reachable";
      health: "ok" | "degraded" | "unreachable" | "unknown";
      daemons: ReadonlyArray<{
        name: string;
        health: "ok" | "degraded" | "unreachable" | "unknown";
        escalation: NeedsAttentionFile | null;
      }>;
      asOf: string;
    }
  | { supervisor: "unreachable"; daemons: readonly [] };
```

`NeedsAttentionFile` is hivedoctor's escalation-record shape (`hivedoctor/src/escalation/needs-attention-store.ts:52`); thehive passes it through opaquely (fs-AC-5) without interpreting its internals - only `isFleetReady()` (fs-AC-6/7/8) and the per-daemon `health` enum drive gating and rendering.

### `isFleetReady()` as a pure, shared function

`isFleetReady()` lives in a module both the route (for a future server-side redirect, if ever needed) and [`prd-002b`](./prd-002b-readiness-splash-ui.md)'s `ReadinessSplash` can import, so the readiness rule is defined exactly once:

```ts
const V1_REQUIRED_PEERS = ["honeycomb"] as const;

function isFleetReady(status: FleetStatusResponse): boolean {
  if (status.supervisor !== "reachable") return false;
  if (status.health !== "ok") return false;
  return V1_REQUIRED_PEERS.every((name) =>
    status.daemons.some((d) => d.name === name && d.health === "ok")
  );
}
```

This mirrors the shape of `resolveEndpointOwner`/`isLoopbackBaseUrl` in `src/shared/daemon-routing.ts`: a small, pure, unit-testable predicate with no I/O, so [`prd-002c`](./prd-002c-acceptance-and-tests.md) can test it exhaustively without a live hivedoctor.

### Why fail-soft returns 200, not 5xx

Returning a 200 with `supervisor: "unreachable"` (fs-AC-3) rather than a 502/504 keeps the browser's poll loop ([`prd-002b`](./prd-002b-readiness-splash-ui.md)) uniform: it always gets parseable JSON and never needs a separate HTTP-error branch distinct from its readiness-not-yet-met branch. This mirrors `wire.setupState()`'s own fail-soft posture (`src/dashboard/web/wire.ts`, falling back to `FRESH_SETUP_STATE` on a failed fetch) - the difference PRD-002 introduces is that the *splash's* fail-soft result blocks forward progress, where `SetupGate`'s fail-soft result today wrongly implies "fresh install."

## Related

- [`prd-002-portal-readiness-splash-index.md`](./prd-002-portal-readiness-splash-index.md) - module scope, the Option B decision, and the hivedoctor `daemons[]` dependency this sub-PRD is blocked on.
- [`prd-002b-readiness-splash-ui.md`](./prd-002b-readiness-splash-ui.md) - the browser component that polls this route and calls `isFleetReady()`.
- [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md) - the pinned note's "hivedoctor contract today vs what the splash needs" section and its fail-soft payload example this sub-PRD implements verbatim.
- [hivenectar PRD-004b](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md) - the `daemons[]` status-page contract (`b-AC-1`, `b-AC-2`) this route consumes.
- `src/daemon/server.ts:55-80` - where `GET /api/fleet-status` is added, alongside `/health` and `/api/daemon-bases`.
- `src/shared/daemon-routing.ts:32-38` - `isLoopbackBaseUrl()`, reused for tamper-safety (fs-AC-9).
- `src/daemon/registry.ts:30-46` - `baseUrlFromHealthUrl()`, the precedent rejection pattern for a registry-sourced, potentially tampered URL.
