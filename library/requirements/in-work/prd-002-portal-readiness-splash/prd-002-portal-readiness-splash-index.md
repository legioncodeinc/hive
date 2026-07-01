# PRD-002: Portal Readiness Splash

> **Status:** In Work
> **Priority:** P0
> **Effort:** M
> **Schema changes:** None (thehive holds no Deep Lake client and persists nothing new; it forwards hivedoctor's status-page JSON)
> **Depends on:** hivedoctor [`prd-004b-hivedoctor-status-and-cli`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md) shipping the `daemons[]` extension to `GET :3852/status.json`. This module is authored against that extended contract and is **blocked** until it lands (see "Dependency status" below).

---

## Overview

PRD-001 shipped thehive's portal daemon (`:3853`) and its dashboard shell, but left a cold-boot UX bug documented in the pinned note [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md) (v1.1, Option B locked): while honeycomb is still booting, `SetupGate` (`src/dashboard/web/setup-gate.tsx`) polls honeycomb's `GET /setup/state` via the federated `wire`, the request fails, `wire.setupState()` fail-softs to `FRESH_SETUP_STATE` (`authenticated: false`), and the UI renders "First time setup" as if this were a fresh install instead of "the hive is waking up." PRD-001's own QA report flagged the adjacent symptom (the `daemonUp` connectivity gate in `app.tsx` is honeycomb-scoped, not per-daemon) as a Warning, not a fix; this PRD is that fix, plus the readiness gate the pinned note calls for.

PRD-002 delivers the **readiness splash**: a portal-level gate that sits in front of `SetupGate`, blocks guided setup and the dashboard until the fleet is confirmed healthy, and never infers "fresh install" from a peer daemon simply being unreachable.

### Decision (locked): Option B - hivedoctor is the single fleet-health source

Per the pinned note, **Option A** (thehive probes each workload's `/health` directly) is rejected: it duplicates probe logic hivedoctor already owns and splits operator truth across two systems. **Option B** is chosen: thehive reads hivedoctor's status page as the fleet-health source of truth, the same trust model as the `daemon-bases` loopback fix ([`prd-001c`](../prd-001-thehive-portal-daemon/prd-001c-api-aggregation-wire.md), `src/shared/daemon-routing.ts`).

| Piece | Responsibility | Sub-PRD |
|---|---|---|
| hivedoctor | Supervises registered daemons, probes registry `healthUrl`s, owns fleet health state | out-of-band (hivenectar PRD-004a/004b) |
| hivedoctor `:3852` | Serves `GET /status.json` with an aggregate `health` plus a per-daemon `daemons[]` array | out-of-band (hivenectar [`prd-004b`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md)) |
| thehive server | `GET /api/fleet-status` - server-side, loopback-only fetch of `http://127.0.0.1:3852/status.json`; fail-soft when hivedoctor is unreachable | [`prd-002a`](./prd-002a-fleet-status-proxy.md) |
| Browser | `ReadinessSplash` polls `/api/fleet-status` every 1-2s; mounts `SetupGate` only once the fleet gate passes | [`prd-002b`](./prd-002b-readiness-splash-ui.md) |

**React tree order:** `ReadinessSplash` wraps `SetupGate`. `SetupGate` must not poll `GET /setup/state` until the fleet gate passes (see [`prd-002b`](./prd-002b-readiness-splash-ui.md)).

---

## Goals

- A portal-level `ReadinessSplash` component renders before `SetupGate` and before any dashboard fetch, on every cold load of `:3853`.
- The splash's gate reads hivedoctor's fleet health via a thehive-owned proxy (`GET /api/fleet-status`), never a direct per-daemon probe from the browser or from thehive's server.
- `SetupGate` never fail-softs into "First time setup" while a required peer is still starting - the fleet gate blocks that phase transition entirely.
- The splash renders a per-daemon grid once hivedoctor's `daemons[]` contract is available, and dismisses into `SetupGate`/`Shell` only when the fleet is ready.
- hivedoctor being unreachable is a distinct, honest state (`supervisor: "unreachable"`) that keeps the splash up indefinitely, never a fall-through to guided setup.

## Non-Goals

- Visual design of the splash (bees, spinner, motion treatment) - a `ux-ui-worker-bee` concern at implementation time, not specified here beyond the copy ("Waiting for the hive...") and the required states per row.
- Direct per-daemon `/health` probing from thehive (Option A) - explicitly rejected by the pinned note and not revisited by this PRD.
- Whether `degraded` fleet health should ever allow setup - the pinned note's default is locked in this PRD's ACs: block until `health === "ok"`, no exception for `degraded`.
- CI/release train concerns (PRD-001's open `m-AC-5`) - unrelated to this module.
- hivedoctor's registry, supervisor, or status-page implementation itself (hivenectar [`prd-004a`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) / [`prd-004b`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md)) - this module consumes that contract as a given.
- hivenectar joining the required-peer set - out of scope for v1 (see "v1 required peers" below); revisit when Source Graph ships.

---

## Features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-002a-fleet-status-proxy`](./prd-002a-fleet-status-proxy.md) | thehive's server-side `GET /api/fleet-status`: loopback-only fetch of hivedoctor's status page, fail-soft payload, the `isFleetReady()` rule, tamper-safety | Draft |
| [`prd-002b-readiness-splash-ui`](./prd-002b-readiness-splash-ui.md) | The `ReadinessSplash` React component: polling, per-daemon grid, the `main.tsx` tree-order change, and gating `SetupGate`'s own poll | Draft |
| [`prd-002c-acceptance-and-tests`](./prd-002c-acceptance-and-tests.md) | Consolidated acceptance criteria (from the pinned note's acceptance sketch) and the Vitest test plan for the proxy + splash component | Draft |

---

## v1 required peers (locked)

The required-peer set that gates the splash in v1 is **`{ honeycomb }` only**:

- thehive's own self-row is informational only, never gating - thehive is always up by the time it can render anything (ADR-0004 decision #1; PRD-001a a-AC-3), so gating on itself would be a no-op that adds a false sense of safety.
- hivenectar is not yet a required peer. It joins the required-peer set when Source Graph ships and a dashboard page depends on it (per the pinned note's "add hivenectar when Source Graph ships"). Until then its row, if present in `daemons[]`, is display-only.

---

## Module acceptance criteria

- [ ] With honeycomb stopped and hivedoctor reporting `degraded` or `unreachable`, `:3853` shows the readiness splash only - never "First time setup" ([`prd-002a`](./prd-002a-fleet-status-proxy.md), [`prd-002b`](./prd-002b-readiness-splash-ui.md)).
- [ ] When hivedoctor reports aggregate `health: "ok"` and honeycomb's `daemons[]` row is `health: "ok"`, the splash dismisses into `SetupGate` (which then runs its own existing pre-auth/authenticated logic unmodified).
- [ ] With honeycomb up but the user lacking DeepLake credentials, the user reaches guided setup - the fleet gate does not block a legitimately fresh install once required peers are healthy.
- [ ] The splash renders before any `GET /setup/state` or dashboard data fetch fires ([`prd-002b`](./prd-002b-readiness-splash-ui.md)).
- [ ] hivedoctor unreachable (`:3852` down) keeps the splash up indefinitely; it never falls through to setup or the dashboard ([`prd-002a`](./prd-002a-fleet-status-proxy.md)).
- [ ] `GET /api/fleet-status` rejects a non-loopback or tampered hivedoctor URL, mirroring the `daemon-bases` security fix (`src/shared/daemon-routing.ts`, `isLoopbackBaseUrl`) ([`prd-002a`](./prd-002a-fleet-status-proxy.md)).
- [ ] `degraded` aggregate fleet health blocks setup exactly like `unreachable`/`unknown` - only `health === "ok"` (plus required-peer rows `ok`) passes the gate ([`prd-002a`](./prd-002a-fleet-status-proxy.md)).

Full AC table with IDs: [`prd-002c-acceptance-and-tests`](./prd-002c-acceptance-and-tests.md).

---

## Dependency status

Today `GET http://127.0.0.1:3852/status.json` returns only coarse fleet health (`health`, `escalation`, `suggestedCommands`, `asOf`; source: `hivedoctor/src/status-page/server.ts`), with no per-daemon `daemons[]` array. That is enough for a binary gate but not enough for the per-daemon grid the pinned note specifies. [`prd-002a`](./prd-002a-fleet-status-proxy.md) and [`prd-002b`](./prd-002b-readiness-splash-ui.md) are authored against the **extended** contract that hivenectar [`prd-004b`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md) (`b-AC-1`, `b-AC-2`) delivers:

```json
{
  "health": "ok" | "degraded" | "unreachable" | "unknown",
  "daemons": [
    { "name": "honeycomb", "health": "ok", "escalation": null },
    { "name": "hivenectar", "health": "unknown", "escalation": null },
    { "name": "thehive", "health": "ok", "escalation": null }
  ],
  "asOf": "2026-07-01T12:00:00.000Z"
}
```

Each `daemons[]` entry's `escalation` field is a `NeedsAttentionFile | null` (`hivedoctor/src/escalation/needs-attention-store.ts:52`) when present, `null` when the daemon has no active escalation. **This PRD is BLOCKED on hivedoctor `prd-004b` shipping this shape** - see the ledger entry in [`EXECUTION_LEDGER.md`](../../../ledger/EXECUTION_LEDGER.md). This module deliberately takes the pinned note's "ship the grid only after `daemons[]` lands" path (preferred; avoids lying about per-row state) rather than the interim coarse-badge fallback.

---

## Related

- [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md) - the pinned product note (v1.1, Option B locked) this PRD implements; its mermaid flow, responsibilities table, hivedoctor contract, and acceptance sketch are the source of truth for this module's ACs.
- [`prd-001-thehive-portal-daemon-index.md`](../prd-001-thehive-portal-daemon/prd-001-thehive-portal-daemon-index.md) - the foundational module this PRD extends; its `SetupGate`/`app.tsx`/`wire.ts` are the files PRD-002b modifies.
- [`prd-001c-api-aggregation-wire.md`](../prd-001-thehive-portal-daemon/prd-001c-api-aggregation-wire.md) - the federated `wire` and loopback trust model (`isLoopbackBaseUrl`) this PRD's proxy mirrors.
- [PRD-001 QA report](../prd-001-thehive-portal-daemon/qa/qa-report-prd-001-thehive-portal-daemon.md) - documents the `daemonUp` honeycomb-scoped gate Warning this PRD resolves.
- [hivenectar ADR-0004](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - decision #1 (always-on + boot order), the architectural basis for gating on fleet health rather than thehive's own liveness.
- [hivenectar PRD-004a](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004a-hivedoctor-registry-config-and-supervisor-instances.md) - the per-daemon state shards hivedoctor's status page reads from.
- [hivenectar PRD-004b](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004b-hivedoctor-status-and-cli.md) - the `daemons[]` status-page extension this PRD is blocked on (`b-AC-1`, `b-AC-2`).
- [hivenectar PRD-004 index](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004-hivedoctor-registry-and-thehive-index.md) - module scope for the hivedoctor/thehive split this PRD's dependency sits inside.
