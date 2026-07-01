# PRD-002c: Acceptance and tests

> Parent: [`prd-002-portal-readiness-splash-index.md`](./prd-002-portal-readiness-splash-index.md)

## Overview

This sub-PRD consolidates the module-level acceptance criteria - adapted directly from the pinned note [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md)'s acceptance sketch - into a single traceable AC table, and lays out the Vitest test plan for [`prd-002a`](./prd-002a-fleet-status-proxy.md)'s proxy route and [`prd-002b`](./prd-002b-readiness-splash-ui.md)'s splash component. It has no implementation of its own; it is the verification contract the other two sub-PRDs are built and reviewed against.

## Goals

- Every bullet in the pinned note's acceptance sketch maps to at least one testable AC ID here.
- The test plan covers the proxy route (`GET /api/fleet-status`, `isFleetReady()`) with the same in-process `app.request(...)` pattern PRD-001's server tests already use, and the splash component with a mocked-fetch harness mirroring `SetupGate`'s existing test posture.
- No AC in this table is untraceable - each cites the pinned note bullet, the 002a/002b AC it verifies, or a concrete file/behavior.

## Non-Goals

- Re-specifying behavior already specified in 002a/002b - this document only aggregates and adds test-plan detail, it does not introduce new product behavior.
- Test implementation itself (this is a plan, not the test code) - `typescript-node-worker-bee`/`react-worker-bee` write the actual Vitest suites when this PRD moves from planning to execution.

---

## User stories + acceptance criteria

### US-1 - consolidated acceptance (from the pinned note's acceptance sketch)

**As** a reviewer, **when** I check this PRD against the pinned note, **I** can trace every acceptance-sketch bullet to a concrete, testable AC.

| ID | Pinned-note bullet | Criterion | Traces to |
|---|---|---|---|
| ac-AC-1 | "With honeycomb stopped and hivedoctor reporting degraded/unreachable, `:3853` shows readiness splash only (no 'First time setup')." | Given honeycomb is stopped and hivedoctor's aggregate `health` is `"degraded"` or `"unreachable"`, when a client loads `:3853`, then `ReadinessSplash` renders and `SetupGate` never mounts (so `GuidedSetup`'s "First time setup" button never renders). | fs-AC-6, fs-AC-7, rs-AC-3 |
| ac-AC-2 | "When hivedoctor reports fleet ok (and required daemons[] rows are up), splash dismisses into setup or dashboard." | Given hivedoctor reports aggregate `health: "ok"` and honeycomb's `daemons[]` row is `health: "ok"`, when `ReadinessSplash` polls, then it mounts `SetupGate`, which then resolves to `GuidedSetup` or `Shell` per its own existing unmodified logic. | fs-AC-6, rs-AC-7, rs-AC-8 |
| ac-AC-3 | "With honeycomb up but no DeepLake credentials, user reaches guided setup (correct phase)." | Given the fleet is ready and the user has no valid credential, when `SetupGate` mounts, then the user reaches `GuidedSetup`, not an error and not an infinite splash. | rs-AC-8 |
| ac-AC-4 | "Splash renders before any /setup/state or dashboard page fetch." | Given a cold load of `:3853`, when the page first paints, then no `GET /setup/state` request and no dashboard `wire` fetch has fired yet - only `GET /api/fleet-status` has. | rs-AC-1, rs-AC-2, rs-AC-3 |
| ac-AC-5 | "hivedoctor down -> splash persists; no setup mis-detection." | Given hivedoctor's `:3852` is down, when `ReadinessSplash` polls indefinitely, then it never mounts `SetupGate` and never shows "First time setup" or any authenticated content. | fs-AC-3, rs-AC-6 |
| ac-AC-6 | "/api/fleet-status rejects non-loopback hivedoctor URLs (tamper-safe, mirrors security fix on daemon-bases)." | Given the route's fetch target, when constructed, then it is validated against `isLoopbackBaseUrl()` before use and never accepts a non-loopback origin from any input source. | fs-AC-2, fs-AC-9 |

### US-2 - the locked "no exception for degraded" rule is tested

**As** a reviewer, **I** confirm the product decision (block on anything short of `ok`) has no untested branch.

| ID | Criterion |
|---|---|
| ac-AC-7 | Given a fleet-status payload with aggregate `health: "degraded"` and every named peer individually `health: "ok"`, when `isFleetReady()` evaluates it, then it still returns `false` - the aggregate `health` field alone is sufficient to block, independent of per-daemon rows. |
| ac-AC-8 | Given a fleet-status payload with aggregate `health: "ok"` but the `honeycomb` entry missing from `daemons[]`, when `isFleetReady()` evaluates it, then it returns `false` (this is fs-AC-8 restated as the acceptance-level guarantee that a stale/incomplete payload cannot slip through). |

---

## Test plan

### Proxy route (`prd-002a`) - Vitest, in-process `app.request(...)`

Mirrors the existing pattern in `tests/daemon/server.test.ts` (PRD-001c, `/api/daemon-bases`) and `tests/wire/fail-soft.test.ts` (fetch-failure and malformed-JSON empty states):

| Test case | Verifies |
|---|---|
| `GET /api/fleet-status` with a mocked `fetch` returning a well-formed hivedoctor payload | fs-AC-1, fs-AC-5 - reachable pass-through shape |
| `GET /api/fleet-status` with a mocked `fetch` that rejects (simulated connection refused) | fs-AC-3 - fail-soft to `{ supervisor: "unreachable", daemons: [] }` |
| `GET /api/fleet-status` with a mocked `fetch` returning non-JSON body | fs-AC-4 - fail-soft, no throw |
| `GET /api/fleet-status` with a mocked `fetch` returning a 500 from hivedoctor | fs-AC-3/fs-AC-4 - treated as unreachable, not forwarded as a 500 to the client |
| Unit test: `isFleetReady()` with aggregate `ok` + `honeycomb: ok` | fs-AC-6 - returns `true` |
| Unit test: `isFleetReady()` with aggregate `degraded` + `honeycomb: ok` | fs-AC-7, ac-AC-7 - returns `false` |
| Unit test: `isFleetReady()` with aggregate `ok` + `honeycomb` entry absent | fs-AC-8, ac-AC-8 - returns `false` |
| Unit test: `isFleetReady()` with `supervisor: "unreachable"` | fs-AC-6 (the `supervisor !== "reachable"` short-circuit) - returns `false` |
| Unit test: fetch target construction rejects a non-loopback override | fs-AC-2, fs-AC-9, ac-AC-6 - mirrors `tests/wire/registry.test.ts`'s malformed/tampered-registry cases |
| Response-shape test: client-facing body never contains an upstream stack trace or raw error string | fs-AC-10 |

### Splash component (`prd-002b`) - Vitest + a mocked-fetch harness

Mirrors `SetupGate`'s own testable posture (`client?: WireClient` injection point, `setup-gate.tsx:70-75`) by giving `ReadinessSplash` an equivalent seam (an injectable fetch or a `client` prop) rather than reaching for a real network call in tests:

| Test case | Verifies |
|---|---|
| First render, before any poll resolves | rs-AC-2 - splash state shown by default, `SetupGate` not mounted |
| Poll resolves with `supervisor: "unreachable"` | rs-AC-6, ac-AC-1, ac-AC-5 - distinct "waiting on hivedoctor" state, no `SetupGate` |
| Poll resolves with aggregate `degraded`, honeycomb `ok` | rs-AC-5, ac-AC-1, ac-AC-7 - still splash, not `SetupGate` |
| Poll resolves with aggregate `ok`, honeycomb `ok` | rs-AC-7, ac-AC-2 - transitions to `SetupGate`, polling stops (assert no further `fetch` calls after the transition) |
| `SetupGate`'s `/setup/state` fetch is never called before the fleet-ready transition | rs-AC-3, ac-AC-4 - a spy/mock on the `wire`/fetch layer records zero `/setup/state` calls pre-transition |
| Per-daemon grid renders one row per `daemons[]` entry with the correct mapped state | rs-AC-5 - table-driven over `ok`/`degraded`/`unreachable`/`unknown` |
| Poll interval is between 1000ms and 2000ms (fake timers) | rs-AC-4 |
| Once ready, an already-mounted `SetupGate`/`Shell` is not remounted/unmounted by a later `degraded` poll (out of scope per rs-AC-9, tested as a non-regression guard) | rs-AC-9 |

## Related

- [`prd-002-portal-readiness-splash-index.md`](./prd-002-portal-readiness-splash-index.md) - module scope and the module-level acceptance criteria this sub-PRD expands with IDs.
- [`prd-002a-fleet-status-proxy.md`](./prd-002a-fleet-status-proxy.md) - the `fs-AC-*` criteria this test plan verifies.
- [`prd-002b-readiness-splash-ui.md`](./prd-002b-readiness-splash-ui.md) - the `rs-AC-*` criteria this test plan verifies.
- [`portal-readiness-splash.md`](../../../knowledge/private/frontend/portal-readiness-splash.md) - the acceptance sketch this table adapts line-for-line.
- `tests/daemon/server.test.ts`, `tests/wire/fail-soft.test.ts`, `tests/wire/registry.test.ts` (PRD-001 test suites) - the existing test patterns this plan mirrors rather than reinvents.
