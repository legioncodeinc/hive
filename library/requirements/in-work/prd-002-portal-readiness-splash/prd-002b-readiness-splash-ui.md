# PRD-002b: Readiness splash UI

> Parent: [`prd-002-portal-readiness-splash-index.md`](./prd-002-portal-readiness-splash-index.md)

## Overview

This sub-PRD delivers the `ReadinessSplash` React component and the tree-order change that wraps `SetupGate` (`src/dashboard/web/setup-gate.tsx`) with it. `ReadinessSplash` polls [`prd-002a`](./prd-002a-fleet-status-proxy.md)'s `GET /api/fleet-status` every 1-2 seconds and renders a per-daemon grid; it mounts `SetupGate` (and everything downstream, including the authenticated `Shell`) only once `isFleetReady()` returns `true`. This is the browser half of Option B and the direct fix for the cold-boot bug the pinned note documents: today `SetupGate` polls honeycomb's `GET /setup/state` unconditionally from first render (`src/dashboard/web/setup-gate.tsx:408-427`), so a not-yet-ready honeycomb is misread as "fresh install." `ReadinessSplash` moves the readiness question in front of that poll entirely.

The mount point is `src/dashboard/web/main.tsx`, which today renders `<SetupGate assetBase={assetBase} />` directly (`main.tsx:34-38`). This sub-PRD changes exactly that render call's argument, wrapping it in `<ReadinessSplash>`.

## Goals

- `ReadinessSplash` is the first thing rendered into `#root` on every load of `:3853`, before `SetupGate` mounts and before `SetupGate`'s `GET /setup/state` poll can fire.
- `ReadinessSplash` polls `GET /api/fleet-status` on a 1-2s interval and renders a per-daemon grid (name + state) once `daemons[]` data is available.
- `ReadinessSplash` renders `<SetupGate assetBase={assetBase} />` as its child only when `isFleetReady()` (from [`prd-002a`](./prd-002a-fleet-status-proxy.md)) returns `true` for the latest poll result.
- The splash copy and per-row states map cleanly onto the pinned note's minimum spec: a short "Waiting for the hive..." message, and a `starting | up | degraded | unreachable` state per required-peer row.

## Non-Goals

- The proxy route, its fail-soft payload, and the `isFleetReady()` predicate itself - that is [`prd-002a`](./prd-002a-fleet-status-proxy.md); this sub-PRD only consumes it.
- Visual polish (bees, spinner animation, brand treatment) - explicitly deferred to `ux-ui-worker-bee` at implementation time per the parent index's non-goals.
- Any change to `SetupGate`'s own internal logic (its pre-auth/authenticated branches, the migration/coexistence wizards) beyond the one constraint that it must not start polling `/setup/state` before the fleet gate passes.
- Adding hivenectar as a gating peer - it renders as a display-only row if present in `daemons[]`, per the parent index's "v1 required peers."

---

## User stories + acceptance criteria

### US-1 - splash renders first, before any setup/dashboard fetch

**As** a user opening `:3853` on a cold boot, **when** the page loads, **I** see a readiness splash, not "First time setup" or a dashboard fetch.

| ID | Criterion |
|---|---|
| rs-AC-1 | Given `src/dashboard/web/main.tsx`'s `mount()` function, when it renders into `#root`, then it renders `<ReadinessSplash assetBase={assetBase}>` wrapping `<SetupGate assetBase={assetBase} />`, replacing the current direct `<SetupGate assetBase={assetBase} />` render (`main.tsx:34-38`). |
| rs-AC-2 | Given `ReadinessSplash` has not yet received its first `/api/fleet-status` response, when it renders, then it shows the splash state by default (never `SetupGate`) - mirroring `SetupGate`'s own "first render shows the safe default" posture (`setup-gate.tsx:398-399`, `FRESH_SETUP_STATE`). |
| rs-AC-3 | Given the fleet gate has not passed, when `ReadinessSplash` renders, then `SetupGate` is not mounted at all (not mounted-but-hidden) - so `SetupGate`'s `useEffect` poll of `/setup/state` (`setup-gate.tsx:408-427`) cannot fire until the gate passes. |

### US-2 - polling and per-daemon grid

**As** an operator watching the splash, **I** see live per-daemon health while the fleet boots.

| ID | Criterion |
|---|---|
| rs-AC-4 | Given `ReadinessSplash` is mounted and the fleet is not yet ready, when it polls, then it calls `GET /api/fleet-status` on an interval between 1000ms and 2000ms (matching `SETUP_POLL_MS`'s existing 2500ms precedent in spirit, `setup-gate.tsx:45`, but faster per the pinned note's "every 1 to 2s"). |
| rs-AC-5 | Given a `supervisor: "reachable"` response with a non-empty `daemons[]`, when `ReadinessSplash` renders, then it shows one row per `daemons[]` entry with the daemon's `name` and a mapped display state (`up` for `health: "ok"`, `degraded` for `health: "degraded"`, `unreachable` for `health: "unreachable"`, `starting` for `health: "unknown"`). |
| rs-AC-6 | Given a `supervisor: "unreachable"` response (`daemons: []`), when `ReadinessSplash` renders, then it shows a distinct "waiting on hivedoctor" state rather than an empty grid, so an operator can tell "hivedoctor is down" apart from "hivedoctor reports zero daemons." |
| rs-AC-7 | Given the fleet becomes ready mid-poll, when the next `/api/fleet-status` response reports `isFleetReady() === true`, then `ReadinessSplash` stops polling (clears its interval) and renders `SetupGate` in the same tick, with no intermediate blank frame. |

### US-3 - `SetupGate` never fires early

**As** a fresh-install user, **when** I actually have no credential, **I** still reach guided setup once the fleet is healthy - the splash is a gate, not a permanent block.

| ID | Criterion |
|---|---|
| rs-AC-8 | Given the fleet is ready (honeycomb `health: "ok"`, aggregate `health: "ok"`) and the user has no valid credential, when `SetupGate` mounts, then it proceeds through its existing unmodified logic and reaches `GuidedSetup` (`setup-gate.tsx:84-185`) exactly as it does today - PRD-002 changes nothing about `SetupGate`'s internal branches. |
| rs-AC-9 | Given the fleet was ready and then hivedoctor becomes unreachable while `SetupGate`/`Shell` is already mounted (a post-boot flap, not the cold-boot case), when this happens, then `ReadinessSplash` does not unmount an already-mounted `SetupGate`/`Shell` mid-session - the gate applies once, at initial mount, not as a continuous kill-switch (out of scope: a post-mount fleet-health banner is a future enhancement, not this PRD). |

---

## Implementation notes

### Component shape

```tsx
export function ReadinessSplash({
  assetBase,
  pollMs = 1500,
}: {
  assetBase: string;
  pollMs?: number;
}): React.JSX.Element {
  const [status, setStatus] = React.useState<FleetStatusResponse | null>(null);

  React.useEffect(() => {
    if (status !== null && isFleetReady(status)) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      const response = await fetch("/api/fleet-status");
      const next = (await response.json()) as FleetStatusResponse;
      if (alive) setStatus(next);
    };
    void tick();
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [status]);

  if (status !== null && isFleetReady(status)) {
    return <SetupGate assetBase={assetBase} />;
  }
  return <FleetGrid status={status} />;
}
```

This mirrors `SetupGate`'s own effect shape (`setup-gate.tsx:408-427`: poll while not-ready, stop once ready, `alive` flag to avoid a post-unmount `setState`) rather than inventing a new pattern - the codebase already has one correct "poll until gate passes, then stop" implementation to copy.

### `main.tsx` change (rs-AC-1)

```tsx
createRoot(root).render(
  <React.StrictMode>
    <ReadinessSplash assetBase={assetBase} />
  </React.StrictMode>,
);
```

`ReadinessSplash` takes over the position `SetupGate` occupies today (`main.tsx:34-38`) and renders `SetupGate` itself once ready, so `main.tsx`'s only change is the top-level component named in the `render()` call.

### Per-daemon state mapping (rs-AC-5)

| hivedoctor `daemons[].health` | Splash row state | Copy |
|---|---|---|
| `"ok"` | `up` | e.g. a green dot + daemon name |
| `"degraded"` | `degraded` | e.g. a yellow dot + daemon name |
| `"unreachable"` | `unreachable` | e.g. a red dot + daemon name |
| `"unknown"` | `starting` | e.g. a pulsing dot + daemon name (the pre-boot default) |

`supervisor: "unreachable"` (rs-AC-6) is a fifth, distinct top-level state - not a per-daemon row - since there is no `daemons[]` data to render rows from at all.

### Why the gate is "once, at mount" (rs-AC-9)

The pinned note's acceptance sketch is scoped to the cold-boot phase transition (splash to setup-or-dashboard), not a continuous live health banner for an already-authenticated session. Continuously unmounting an authenticated `Shell` because hivedoctor flapped would be a worse UX regression than the bug this PRD fixes (a logged-in user bounced back to a splash mid-session). A persistent post-mount health indicator is explicitly left as a future enhancement in this sub-PRD's non-goals.

## Related

- [`prd-002-portal-readiness-splash-index.md`](./prd-002-portal-readiness-splash-index.md) - module scope, the Option B decision, and the React tree-order rule this sub-PRD implements.
- [`prd-002a-fleet-status-proxy.md`](./prd-002a-fleet-status-proxy.md) - the `GET /api/fleet-status` endpoint and `isFleetReady()` predicate this component polls and calls.
- [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md) - the pinned note's intended-behavior mermaid flow and minimum splash spec (states, copy, blocking behavior) this sub-PRD realizes.
- `src/dashboard/web/main.tsx:20-41` - the `mount()` function and render call this sub-PRD modifies.
- `src/dashboard/web/setup-gate.tsx:401-446` - `SetupGate`, the component this sub-PRD wraps without modifying its internals; its poll-then-render-once-ready pattern (`:408-427`) is the template `ReadinessSplash` follows.
