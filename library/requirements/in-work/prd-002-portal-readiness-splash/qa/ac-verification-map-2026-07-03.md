# PRD-002 Acceptance Criteria Verification Map

> Category: QA Report | Version: 1.0 | Date: July 2026 | Status: Active

This map traces every PRD-002 acceptance criterion to shipped code and executable tests. The original `ReadinessSplash` React wrapper was retired in favor of the server-side portal gate (PRD-003) plus the `/buzzing` screen (PRD-004); SUPERSEDED rows cite the equivalent mechanism.

**Related:**
- [prd-002-portal-readiness-splash-index.md](../prd-002-portal-readiness-splash-index.md)
- [prd-002a-fleet-status-proxy.md](../prd-002a-fleet-status-proxy.md)
- [prd-002b-readiness-splash-ui.md](../prd-002b-readiness-splash-ui.md)
- [prd-002c-acceptance-and-tests.md](../prd-002c-acceptance-and-tests.md)

## Disposition summary

| Disposition | Count |
|---|---|
| VERIFIED | 19 |
| SUPERSEDED | 16 |
| GAP (OPEN) | 0 |

---

## Module acceptance criteria (index)

| AC | Disposition | Implementation | Test |
|---|---|---|---|
| Honeycomb stopped and doctor reporting degraded/unreachable shows readiness only, never "First time setup" | SUPERSEDED | `src/daemon/gate.ts` redirects unhealthy fleet to `/buzzing` before auth or shell (`isFleetReady()` at lines 37-38, redirect at middleware) | `tests/daemon/gate.test.ts` "g-AC-3 redirects a deep link to /buzzing when the fleet is unhealthy" |
| Fleet ok and honeycomb ok dismisses into setup or dashboard | SUPERSEDED | `BuzzingScreen` calls `onReady` / hard-navigates to `/` when `isFleetReady()` passes (`buzzing-screen.tsx:103-140`); server gate then serves `/` or `/login` | `tests/dashboard/buzzing-screen.test.tsx` "bz-AC-9: transitions away once isFleetReady() is satisfied" |
| Honeycomb up but no Deeplake credentials reaches guided setup | VERIFIED | `LoginScreen` in `setup-gate.tsx` renders guided setup when `authenticated: false` (unchanged by PRD-002) | `tests/dashboard/login-screen.test.tsx` "l-AC-1 renders the existing guided-setup device flow when logged out" |
| Splash renders before any `/setup/state` or dashboard wire fetch | SUPERSEDED | Server gate serves `/buzzing` HTML (not the Shell bundle) while fleet is not ready; client `main.tsx` mounts `BuzzingScreen` only on `/buzzing` | `tests/daemon/gate.test.ts` "g-AC-3 redirects to /buzzing when doctor is unreachable" + `tests/dashboard/boot-route.test.ts` "m-AC-7 resolves /buzzing to the buzzing screen" |
| Doctor down keeps splash up indefinitely | SUPERSEDED | `fetchFleetStatus` fail-soft + gate redirect loop ends at `/buzzing` (exempt route) | `tests/daemon/fleet-status.test.ts` "fs-AC-3 returns fail-soft unreachable when doctor fetch throws" + `tests/dashboard/buzzing-screen.test.tsx` "rs-AC-6: supervisor unreachable with no registered services shows the waiting-on-doctor state" |
| `/api/fleet-status` rejects non-loopback doctor URLs | VERIFIED | `src/daemon/fleet-status.ts:49-50` (`isLoopbackBaseUrl`) | `tests/daemon/fleet-status.test.ts` "fs-AC-9 rejects non-loopback URL without fetching" |
| Degraded aggregate health blocks setup like unreachable | VERIFIED | `src/shared/fleet-readiness.ts:21-26` | `tests/daemon/fleet-status.test.ts` "fs-AC-7 returns false when aggregate health is degraded" + `tests/shared/fleet-readiness.test.ts` "ac-AC-7 returns false when aggregate health is degraded even if every named peer row is ok" |

---

## fs-AC (fleet status proxy)

| AC | Disposition | Implementation | Test |
|---|---|---|---|
| fs-AC-1 | VERIFIED | `src/daemon/server.ts` registers `GET /api/fleet-status`; `src/daemon/fleet-status.ts:45-84` | `tests/daemon/fleet-status.test.ts` "fs-AC-1 proxies doctor status through hive server" |
| fs-AC-2 | VERIFIED | `src/shared/constants.ts:9-10` (`DOCTOR_STATUS_URL`) | `tests/daemon/fleet-status.test.ts` "fs-AC-2 uses hard-pinned loopback constant by default" |
| fs-AC-3 | VERIFIED | `src/daemon/fleet-status.ts:16-19, 49-84` fail-soft unreachable | `tests/daemon/fleet-status.test.ts` "fs-AC-3 returns fail-soft unreachable when doctor fetch throws" + route test "fs-AC-3 route returns 200 with fail-soft body when upstream is down" |
| fs-AC-4 | VERIFIED | `src/daemon/fleet-status.ts` zod parse failure path | `tests/daemon/fleet-status.test.ts` "fs-AC-4 returns fail-soft unreachable on malformed JSON body" |
| fs-AC-5 | VERIFIED | `src/daemon/fleet-status.ts:62-76` pass-through shape | `tests/daemon/fleet-status.test.ts` "fs-AC-5 passes through well-formed status with daemons array" |
| fs-AC-6 | VERIFIED | `src/shared/fleet-readiness.ts:21-26` | `tests/daemon/fleet-status.test.ts` "fs-AC-6 returns true when supervisor reachable, aggregate ok, and honeycomb ok" |
| fs-AC-7 | VERIFIED | `src/shared/fleet-readiness.ts:23-24` | `tests/daemon/fleet-status.test.ts` "fs-AC-7 returns false when aggregate health is degraded" |
| fs-AC-8 | VERIFIED | `src/shared/fleet-readiness.ts:24-26` | `tests/daemon/fleet-status.test.ts` "fs-AC-8 returns false when honeycomb is missing from daemons" |
| fs-AC-9 | VERIFIED | `src/daemon/fleet-status.ts:49-50, 54` (`redirect: "error"`) | `tests/daemon/fleet-status.test.ts` "fs-AC-9 rejects non-loopback URL without fetching" + "fs-AC-9 pins redirect mode" |
| fs-AC-10 | VERIFIED | Normalized response only in route handler | `tests/daemon/fleet-status.test.ts` "fs-AC-10 response body contains only normalized fields" |

---

## rs-AC (ReadinessSplash UI, retired component)

| AC | Disposition | Equivalent mechanism | Test |
|---|---|---|---|
| rs-AC-1 | SUPERSEDED | `main.tsx:48-60` mounts `BuzzingScreen` / `LoginScreen` / `Shell` via `resolveBootScreen` (no `ReadinessSplash` wrapper) | `tests/dashboard/boot-route.test.ts` "m-AC-7 resolves /buzzing to the buzzing screen" |
| rs-AC-2 | SUPERSEDED | `/buzzing` is the default server redirect while fleet is not ready; `BuzzingScreen` renders immediately | `tests/dashboard/buzzing-screen.test.tsx` "bz-AC-1/bz-AC-2: shows one tile per registered service" |
| rs-AC-3 | SUPERSEDED | `SetupGate`/`LoginScreen` only mount on `/login` after server gate passes fleet check; unhealthy requests never receive Shell | `tests/daemon/gate.test.ts` "g-AC-3 redirects a deep link to /buzzing when the fleet is unhealthy, before evaluating auth" |
| rs-AC-4 | VERIFIED | `BuzzingScreen` default `pollMs = 1500` (`buzzing-screen.tsx:96`) | `tests/dashboard/buzzing-screen.test.tsx` "rs-AC-4 polls GET /api/fleet-status on an interval between 1000ms and 2000ms" |
| rs-AC-5 | SUPERSEDED | Per-service tile grid via `useFleetTelemetry` + `ServiceTile` (`buzzing-screen.tsx:200-212`) | `tests/dashboard/buzzing-screen.test.tsx` "bz-AC-7/bz-AC-8: one service failing flips only its own tile" |
| rs-AC-6 | SUPERSEDED | `AwaitingRegistrationIndicator` when no services enumerated (`buzzing-screen.tsx:64-89, 200-201`) | `tests/dashboard/buzzing-screen.test.tsx` "rs-AC-6: supervisor unreachable with no registered services shows the waiting-on-doctor state" |
| rs-AC-7 | SUPERSEDED | Dismissal poll stops when `ready` (`buzzing-screen.tsx:103-104, 124-128`) | `tests/dashboard/buzzing-screen.test.tsx` "bz-AC-9: transitions away once isFleetReady() is satisfied" |
| rs-AC-8 | SUPERSEDED | After fleet ready, server gate serves `/login`; `LoginScreen` runs existing setup branches | `tests/dashboard/login-screen.test.tsx` "l-AC-1 renders the existing guided-setup device flow when logged out" |
| rs-AC-9 | SUPERSEDED | No client wrapper re-gates Shell mid-session; `/buzzing` is a separate boot route. Post-ready doctor flap re-evaluates only on the next HTTP navigation (gate middleware), not by unmounting an in-tree splash | `tests/daemon/gate.test.ts` "g-AC-10 re-runs the identical precedence on every request" (documents per-request gate, not a sticky client kill-switch) |

---

## ac-AC (consolidated acceptance)

| AC | Disposition | Implementation | Test |
|---|---|---|---|
| ac-AC-1 | SUPERSEDED | Same as module AC row 1 (gate + `/buzzing`) | `tests/daemon/gate.test.ts` g-AC-3 cases + `tests/dashboard/buzzing-screen.test.tsx` bz-AC-10 |
| ac-AC-2 | SUPERSEDED | Same as module AC row 2 | `tests/dashboard/buzzing-screen.test.tsx` "bz-AC-9" |
| ac-AC-3 | VERIFIED | Fleet-ready path through gate to `/login` then guided setup | `tests/dashboard/login-screen.test.tsx` "l-AC-1" |
| ac-AC-4 | SUPERSEDED | Unhealthy clients never receive Shell HTML (only `/buzzing`) | `tests/daemon/gate.test.ts` "g-AC-3 redirects to /buzzing FIRST even when also logged out" |
| ac-AC-5 | SUPERSEDED | Doctor unreachable fail-soft + exempt `/buzzing` route | `tests/daemon/fleet-status.test.ts` fs-AC-3 + `tests/dashboard/buzzing-screen.test.tsx` rs-AC-6 |
| ac-AC-6 | VERIFIED | `isLoopbackBaseUrl` guard on fleet-status fetch | `tests/daemon/fleet-status.test.ts` fs-AC-9 |
| ac-AC-7 | VERIFIED | Aggregate `health` gate in `isFleetReady()` | `tests/shared/fleet-readiness.test.ts` "ac-AC-7 returns false when aggregate health is degraded even if every named peer row is ok" |
| ac-AC-8 | VERIFIED | Required peer presence in `isFleetReady()` | `tests/shared/fleet-readiness.test.ts` "ac-AC-8 returns false when honeycomb is missing from daemons despite aggregate ok" |

---

## Verification run (2026-07-03)

```
cd hive && npm run typecheck && npm test
```

Result: typecheck clean, **345/345** tests passing (includes new rs-AC-4, rs-AC-6, ac-AC-7/8, c-AC-3 shell/wire isolation, and install refusal cases from the parallel PRD-009 wave).
