# Portal readiness splash (pinned product note)

> Category: Architecture | Version: 1.1 | Date: July 2026 | Status: Active

Until required workload daemons are reachable, thehive portal must show a **readiness splash** (service health grid, "waiting…", motion) instead of guided setup or dashboard pages. This note pins that intent; it is not implemented in PRD-001 Wave 1.

**Decision (locked): Option B** — the portal uses **hivedoctor as the single fleet-health source** via the status page API, not direct per-daemon `/health` probes from thehive.

**Related:** [ADR-0004 decision #1](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md), [`prd-001-thehive-portal-daemon-index.md`](../../../requirements/in-work/prd-001-thehive-portal-daemon/prd-001-thehive-portal-daemon-index.md), [`qa-report-prd-001-thehive-portal-daemon.md`](../../../requirements/in-work/prd-001-thehive-portal-daemon/qa/qa-report-prd-001-thehive-portal-daemon.md) (Warning: honeycomb-scoped `daemonUp` gate), `hivedoctor/src/status-page/server.ts` (`GET :3852/status.json`)

---

## Problem (observed today)

On a cold device, thehive binds `:3853` and serves the React bundle immediately (correct per ADR-0004 #1). The top-level UI is still **`SetupGate`**, copied from honeycomb's in-daemon dashboard:

1. `SetupGate` polls `GET /setup/state` on **honeycomb** (`:3850`) via the federated `wire`.
2. When honeycomb is not up yet, `wire.setupState()` **fail-softs to `FRESH_SETUP_STATE`** (`authenticated: false`).
3. The UI renders **"First time setup"** / guided setup, as if this were a fresh install.
4. Clicking setup tries `POST /setup/login` against a dead honeycomb and errors.

That is the wrong phase. A first-time user with services still booting should see **"The hive is waking up"**, not onboarding.

The authenticated **`Shell`** (sidebar + pages) only mounts after `setupState.authenticated === true`. There is no portal-level gate that says "wait until the supervisor reports the fleet ready" before setup or dashboard.

---

## Intended behavior (pinned)

```mermaid
flowchart TD
    open["User opens :3853"] --> splash["Readiness splash"]
    splash --> poll["Poll thehive /api/fleet-status"]
    poll --> proxy["Server fetches hivedoctor :3852/status.json"]
    proxy -->|fleet ready| setupOrDash["SetupGate OR Shell"]
    proxy -->|not ready| splash
    setupOrDash --> setup["Guided setup if unauthenticated"]
    setupOrDash --> dash["Dashboard if authenticated"]
```

**Readiness splash** (minimum):

- thehive itself is up (always true once the page loads).
- Per-daemon rows for each **required** peer (at minimum **honeycomb**; add **hivenectar** when Source Graph ships).
- State per row: `starting`, `up`, `degraded`, `unreachable` (mapped from hivedoctor supervisor truth).
- Copy: short "Waiting for the hive…" plus optional motion (spinner, bees, etc.).
- **Block** guided setup and dashboard routes until hivedoctor reports required deps ready.

**Do not** infer fresh install from a failed `/setup/state` while the fleet is not ready.

---

## Decision: Option B (hivedoctor status, locked)

**Rejected:** Option A (thehive probes each workload `/health` directly). That duplicates probe logic hivedoctor already owns and splits operator truth across two systems.

**Chosen:** Option B — thehive reads **hivedoctor's status page** as the fleet-health source of truth.

| Piece | Responsibility |
|---|---|
| **hivedoctor** | Supervises registered daemons, probes registry `healthUrl`s, owns fleet health state |
| **hivedoctor `:3852`** | Serves `GET /status.json` (today: coarse fleet health + escalation + suggested commands) |
| **thehive server** | `GET /api/fleet-status` — server-side fetch of `http://127.0.0.1:3852/status.json` (loopback-only, same trust model as `daemon-bases`); never expose raw hivedoctor URL to the browser if CORS is awkward |
| **Browser** | `ReadinessSplash` polls `/api/fleet-status` every 1 to 2s; mounts `SetupGate` only when fleet gate passes |

**React tree order:** `ReadinessSplash` wraps `SetupGate`. `SetupGate` must not poll `/setup/state` until readiness passes.

---

## hivedoctor contract today vs what the splash needs

Today `GET http://127.0.0.1:3852/status.json` returns only **coarse** fleet health:

```json
{
  "health": "ok" | "degraded" | "unreachable" | "unknown",
  "escalation": { ... } | null,
  "suggestedCommands": [ "..." ],
  "asOf": "2026-07-01T12:00:00.000Z"
}
```

Source: `hivedoctor/src/status-page/server.ts`.

That is enough for a **binary gate** ("fleet not ok → stay on splash") but **not** enough for a per-daemon grid (honeycomb row vs hivenectar row).

**Follow-up on hivedoctor (PRD-004a / status-page extension):** extend `/status.json` with a `daemons` array, for example:

```json
{
  "health": "degraded",
  "daemons": [
    { "name": "honeycomb", "health": "ok", "healthUrl": "http://127.0.0.1:3850/health" },
    { "name": "hivenectar", "health": "starting", "healthUrl": "http://127.0.0.1:3854/health" },
    { "name": "thehive", "health": "ok", "healthUrl": "http://127.0.0.1:3853/health" }
  ],
  "asOf": "..."
}
```

Until that lands, the splash can:

1. Show coarse fleet badge from `health` alone, plus registry-derived daemon **names** as all `starting` when `health !== "ok"`, or
2. Ship the grid only after hivedoctor exposes `daemons[]` (preferred; avoids lying about per-row state).

**Fail-soft:** if hivedoctor is unreachable (`:3852` down), `/api/fleet-status` returns `{ supervisor: "unreachable", daemons: [] }` and the splash stays up (never fall through to guided setup).

---

## How health works today (baseline before this feature)

| Layer | What it does | Source of truth |
|---|---|---|
| **thehive process** | `GET :3853/health` | Own uptime only |
| **thehive server** | `GET :3853/api/daemon-bases` | Registry **file** (`~/.honeycomb/hivedoctor.daemons.json`) for wire routing |
| **Browser `wire`** | Dashboard data fetches | Workload APIs via federated bases |
| **hivedoctor** | Supervision + status page | `:3852/status.json` (not consumed by portal UI yet) |

---

## Acceptance sketch (when implemented)

- [ ] With honeycomb stopped and hivedoctor reporting `degraded`/`unreachable`, `:3853` shows readiness splash only (no "First time setup").
- [ ] When hivedoctor reports fleet `ok` (and required `daemons[]` rows are `up`), splash dismisses into setup or dashboard.
- [ ] With honeycomb up but no DeepLake credentials, user reaches guided setup (correct phase).
- [ ] Splash renders before any `/setup/state` or dashboard page fetch.
- [ ] hivedoctor down → splash persists; no setup mis-detection.
- [ ] `/api/fleet-status` rejects non-loopback hivedoctor URLs (tamper-safe, mirrors security fix on `daemon-bases`).

---

## Out of scope for this note

- Visual design of bees/spinner (ux-ui-worker-bee when implementing).
- Whether `degraded` fleet health allows setup (product call; default: block setup until `ok` or explicit per-daemon `up`).
- CI/release train (m-AC-5).
- Option A (direct workload `/health` probes from thehive).
