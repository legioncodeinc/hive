# Pre-Release Gap Review: Hive Core Functionality

> Category: QA | Type: Pre-release gap review | Date: 2026-07-03 | Status: Complete
> Scope: hive/README.md, library/knowledge/** (public + private), library/requirements/** (in-work, backlog, archive), traced into src/** and tests/**
> Auditor: pre-release QA (read-only; no source modified)
> Verification: `tsc --noEmit` clean on the current tree. `vitest run` could not execute in the audit sandbox (Windows-installed node_modules, missing rolldown native binding); CI (`.github/workflows/ci.yaml`) runs the full suite on a three-OS matrix and is the standing gate.

---

## Summary verdict

**PARTIAL. The engineering delivers the spirit. The paperwork and one gating rule undercut it.**

The core promises hold up under code inspection, and hold up well. Hive is a real always-on portal daemon: it binds `127.0.0.1:3853` before any workload is healthy, holds no Deep Lake client anywhere in `src/` (verified by grep; the only matches are UI copy), and serves everything through a server-side BFF proxy (`src/daemon/proxy.ts`) that does exactly what ADR-0002 says: owner resolution from doctor's registry, loopback triple-defense (parse-time filter, use-time re-check, `redirect: "error"` on every server-side fetch), hop-by-hop header hygiene with zero header injection, transparent auth pass-through, and per-daemon fail-soft 502s. The landing gate (ADR-0004) is implemented with hard-coded redirect literals and fail-closed auth. The SSE telemetry relay, the five-state service derivation, the `/buzzing` screen, the health rail, and the `/health` page are all real, tested code. The private knowledge base is unusually honest and current; it even self-reports its own paperwork drift.

Three things keep this from a clean YES:

1. The landing gate keys on doctor's AGGREGATE health, which degrades when ANY registered daemon degrades. So a dead nectar, a daemon that is not even required by most pages, sends every fresh page load to `/buzzing`. That contradicts the project's own fail-soft promise ("one daemon down degrades one panel, not the whole page"), the README, the public overview, and the docs' explicit "nectar is display-only, not a required peer" claim. This is the one finding I would not ship without fixing or consciously accepting in writing.
2. The requirements tree misstates program state badly enough to embarrass the project: three shipped PRDs sit in `backlog/` with unchecked ACs and empty `qa/` folders, `completed/` is empty, and PRD-002's verified artifact was later deleted and replaced without the PRD being marked superseded.
3. A handful of public-surface warts: a broken screenshot image in the README, undisclosed telemetry, and a stale status section.

Fix finding 1 (or write down the acceptance), do the PRD housekeeping, patch the README, and this is a credible public release.

---

## Scorecard

| Area | Verdict | Severity of worst finding |
|---|---|---|
| Always-on portal process (bind-before-healthy, lock, service units, boot order) | PASS | none |
| No storage client of its own | PASS | none |
| Server-side BFF proxy (routing, header hygiene, streaming, SSRF defense) | PASS | none |
| Fail-soft degradation, data layer (wire zod + empty states, per-daemon 502) | PASS | none |
| Fail-soft degradation, page level (gate vs the one-panel promise) | FAIL | CRITICAL |
| Landing gate and path routing (ADR-0004 mechanics) | PASS with drift | HIGH (aggregate vs required peers, part of the CRITICAL above) |
| Fleet health surfaces (/buzzing, health rail, /health, SSE relay) | PASS | none |
| Honeycomb subsystem health strip (PRD-029 carryover) | FAIL (silently dead) | MEDIUM |
| Requirements lifecycle accuracy (PRD folders vs reality) | FAIL | HIGH |
| Knowledge base accuracy | PASS (current, self-honest) | LOW |
| README / public docs accuracy | PARTIAL | MEDIUM |
| Telemetry egress discipline | PASS in code, FAIL on disclosure | MEDIUM |
| Security posture (loopback, redirects, no credentials, asset allow-lists) | PASS | LOW |
| Release train (CI + OIDC release workflow) | PASS (npm bootstrap pending, documented) | none |

---

## Detailed findings

### F-1. CRITICAL: Any registered daemon going unhealthy blocks the entire portal on fresh loads

**What the docs claim.**
- README (line 102): "Fail-soft aggregation. One daemon down means one panel shows unreachable while the rest of the dashboard keeps working."
- README (line 179): "Kill a workload daemon mid-session and the dashboard doesn't blink: that daemon's panels go unreachable, everything else keeps rendering."
- `library/knowledge/public/overview/overview.md`: "If one service goes down, its panels say 'unreachable' while the rest of the dashboard keeps working."
- `library/knowledge/private/architecture/landing-gate-and-routing.md`: "Nectar is not yet a required peer (it joins when a shipped page depends on it); its row is display-only."
- PRD-002 index, "v1 required peers (locked)": the gating set is `{ honeycomb }` only.
- ADR-0004: "'Not healthy' means doctor reports the required services unhealthy, or doctor is itself unreachable."

**What the code does.**
- `src/shared/fleet-readiness.ts:21-27`: `isFleetReady()` returns false whenever `status.health !== "ok"`. That `health` field is doctor's aggregate.
- `doctor/src/compose/index.ts:153-163` (`aggregateDaemonHealth`): the aggregate is `unreachable` if ANY registered daemon is unreachable, `degraded` if ANY is degraded, and `degraded` if any is `unknown` while others are not.
- `src/daemon/gate.ts:136-139`: the gate runs `isFleetReady()` on every non-exempt page navigation and 302s to `/buzzing` on false.

Put together: nectar crashes, doctor's aggregate flips to `unreachable`, and every fresh page load, every refresh, every deep link, every new tab on the ENTIRE portal redirects to `/buzzing`. That includes `/memories`, `/roi`, `/logs`, and the operator-facing `/health` page, all of which are honeycomb- or doctor-backed and perfectly able to render. The `V1_REQUIRED_PEERS` machinery is effectively dead weight: the aggregate check already requires every registered daemon to be `ok`, so the "required peers" list never gets a chance to relax anything. The "nectar is display-only" statements in the PRD and knowledge docs are not what the code does.

**What still works.** Mid-session SPA navigation is client-side (`history.pushState`), so an operator already on the dashboard keeps their session and the wire degrades the dead daemon's panels fail-soft, exactly as promised. The README's "mid-session" sentence is accurate. The break is on any full page load.

**Why it matters.** This is the exact failure mode hive exists to eliminate, resurrected one layer up. The old world: honeycomb dies, dashboard dies. The new world: any registered daemon (nectar today, anything registered tomorrow) degrades, and the portal's whole page surface is unreachable on load. The `/health` page is blocked precisely when it is most useful. A flaky nectar bricks fresh loads of a dashboard that mostly does not need nectar. As the fleet grows, the blast radius grows with it, because every new registration joins the aggregate.

**Note on intent.** ADR-0004 deliberately chose health-before-auth gating, and PRD-003's ACs are met as written. The drift is narrower than "the gate should not exist": ADR-0004 says "required services", the PRDs say required means `{ honeycomb }`, and the implementation gates on ALL services via the aggregate. The implementation is stricter than its own spec.

**Suggested fix.** Change `isFleetReady()` to gate on `supervisor === "reachable"` plus the required-peer rows only, and drop the aggregate `health !== "ok"` short-circuit (or scope it to required peers). One line of intent: a non-required daemon's health must never block the portal. Update `tests/daemon/fleet-status.test.ts` cases fs-AC-6/7 accordingly, since ac-AC-7 ("aggregate degraded with every named peer ok still blocks") currently pins the wrong behavior for the multi-daemon fleet. If the team instead decides the strict gate IS the product, then fix the README, the public overview, the "display-only" claims, and ADR-0004's "required services" wording to say so plainly, and consider exempting the `/health` page from the health half of the gate so operators can reach diagnostics during an outage.

---

### F-2. HIGH: The requirements tree misstates program state; shipped work has no QA close-out

**What the docs claim.**
- `library/requirements/backlog/prd-003.../prd-003-...-index.md`: "Status: Backlog". Same for PRD-004 and PRD-005. All three have unchecked module AC checkboxes and `qa/` folders containing only `.gitkeep`.
- `library/requirements/completed/` contains only a README. `library/requirements/in-work/` holds PRD-001 and PRD-002, whose ledgers say 26/27 and 19/19 VERIFIED.

**What the code does.** PRD-003, PRD-004, and PRD-005 are fully implemented on main: `src/daemon/gate.ts`, `src/dashboard/web/boot-route.ts`, `router.tsx` (path routing), `buzzing-screen.tsx`, `service-icons.tsx`, `src/shared/service-status.ts`, `health-rail.tsx`, `pages/health.tsx`, `src/daemon/telemetry-proxy.ts`, `use-fleet-telemetry.ts`, plus matching test files (`tests/daemon/gate.test.ts`, `tests/dashboard/buzzing-screen.test.tsx`, `health-rail.test.tsx`, `health-page.test.tsx`, and more). The knowledge base admits it outright (`buzzing-and-health-rail.md`, "Status honesty, up front": "The code is ahead of the PRD paperwork").

**Why it matters.** Two ways. First, credibility: the README says "We document what's real and flag what's in flight," and the requirements tree fails that test on day one for anyone who browses it. Second, process: this repo's own smoker discipline is security-worker-bee then quality-worker-bee per PRD before ship. PRD-001 and PRD-002 got that treatment (and both audits found real issues: one High SSRF, one Medium redirect-follow). PRD-003/004/005, which include the server gate, the auth check, and a new SSE relay, three security-relevant surfaces, shipped with no security or quality close-out on record. The gate code reads clean to me (fail-closed auth, hard-coded redirects, pinned fetches), but "reads clean to one reviewer" is not the bar this project set for itself.

**Suggested fix.** Move PRD-001 and PRD-002 to `completed/` (PRD-002 with a superseded note, see F-3). Move PRD-003/004/005 to `in-work/` or `completed/`, check their AC boxes against the evidence, and run the security + quality close-outs retroactively so each `qa/` folder holds real reports. Cheap work, big trust payoff.

---

### F-3. HIGH: PRD-002's verified artifact was deleted and replaced; the PRD and its QA trail were never reconciled

**What the docs claim.**
- PRD-002 (in-work) specifies `ReadinessSplash` wrapping `SetupGate` in `main.tsx`, and its QA report plus the execution ledger record rs-AC-1..9 as VERIFIED against `src/dashboard/web/readiness-splash.tsx` and `tests/dashboard/readiness-splash-render.test.tsx`.
- `prd-002a-fleet-status-proxy.md` describes the route as sitting "beside the existing /health and /api/daemon-bases routes" and cites `GET /api/daemon-bases` (`src/daemon/server.ts:72`) as the trust-model precedent.
- PRD-002's index still says the module "is BLOCKED on doctor prd-004b" shipping `daemons[]`.

**What the code does.**
- `readiness-splash.tsx` and its tests no longer exist in `src/` or `tests/`. `main.tsx` says it plainly: "This RETIRES the nested ReadinessSplash -> SetupGate pre-mount gate" (PRD-003c). The replacement is the server gate plus `/buzzing`.
- `/api/daemon-bases` was removed by ADR-0002; grep of `src/daemon/server.ts` confirms no such route.
- Doctor's `daemons[]` extension shipped; `fetchFleetStatus` consumes it in production.

**What survives.** The PRD-002a half (fs-AC-1..10) is alive and correct: `src/daemon/fleet-status.ts` matches the spec, including the fail-soft `{ supervisor: "unreachable", daemons: [] }` 200 body, the zod parse, the loopback pin, and `redirect: "error"`. The intent of the rs-AC half is preserved by the successor screens. The pinned note (`portal-readiness-splash.md`) got the correct treatment: marked Superseded with pointers to current docs. The PRD itself did not.

**Why it matters.** An in-work PRD whose ledger says VERIFIED, referencing files that do not exist and an endpoint an Active ADR says was removed, is exactly the kind of thing an outside reviewer trips over in the first hour. It also poisons traceability: rs-AC rows point at dead paths.

**Suggested fix.** Annotate PRD-002 the same way the pinned note was annotated: rs-AC-1..9 superseded by PRD-003/PRD-004 (gate + `/buzzing`), fs-AC-1..10 still live, `/api/daemon-bases` references struck, "Dependency status" section closed out. Then move it to `completed/`.

---

### F-4. MEDIUM: The honeycomb subsystem health strip is silently dead, and `daemonUp` no longer means what the code says it means

**What the docs and code comments claim.**
- `src/dashboard/web/app.tsx` (module doc): "The /health LIVENESS poll + daemonUp. When the daemon is unreachable the CONTENT region swaps for the ConnectivityBanner."
- `src/dashboard/web/wire.ts` (`HealthReasonsSchema`, ~line 963): the PRD-029 per-subsystem reasons block (storage / embeddings / schema / portkey) that "the daemon's /health body carries" in local mode.
- `src/dashboard/web/pages/dashboard.tsx:120-160`: `HealthStrip` renders those reasons; the shell "owns the single /health poll and passes the reasons down."
- `spa-architecture.md`: pages "gate polling on daemonUp."

**What the code does.** `wire.health()` fetches `ENDPOINTS.health = "/health"` same-origin with `accept: application/json`. Since ADR-0002 made the wire same-origin, that request hits HIVE's own `/health` handler (`src/daemon/server.ts:105-116`), which is registered ahead of the proxy and answers itself with `{ status, uptimeMs, version }`. It never reaches honeycomb. Consequences:

1. The body carries no `reasons`, so `healthReasons` is permanently `null` and `HealthStrip` (`dashboard.tsx:127-128`, `if (reasons === null) return null`) can never render. The PRD-029 subsystem strip, carried through the copy-and-own migration as working UI, is dead code that looks alive.
2. `daemonUp` now measures whether the browser can reach hive itself, which is nearly always true while a page is rendering. The `ConnectivityBanner` whole-content swap only fires if the hive process dies mid-session. Honeycomb going down no longer trips it.

**The irony.** PRD-001's QA report flagged the `daemonUp` gate as a Warning because it was honeycomb-scoped and would blank a future nectar page. The BFF migration mooted that warning by accident: the gate is now hive-scoped and blanks nothing. The outcome is actually closer to the fail-soft spirit (panels degrade individually via the wire's empty states), but nobody decided it, the comments still describe the old semantics, and the strip died as collateral.

**Why it matters.** Dead UI plus misleading comments in the largest client files is a maintenance trap: the next person to touch health rendering will reason from comments that describe a data flow that no longer exists. And the operator lost a real (if small) feature: honeycomb's storage/embeddings/portkey states are no longer visible on the dashboard page (the `/health` page's telemetry-driven Deep Lake block partially covers it).

**Suggested fix.** Pick one deliberately. Either (a) route a proxied honeycomb health read for the strip (add an `ENDPOINTS` entry like `/api/health` proxied to honeycomb's `/health`, keep hive's own `/health` for liveness), or (b) delete `HealthStrip`, `HealthReasonsSchema`, the `healthReasons` PageProps plumbing, and rewrite the `app.tsx`/`wire.ts` comments to say `daemonUp` means "hive reachable." Option (b) is defensible now that the doctor-fed `/health` page and rail exist; it just needs to be chosen, not drifted into.

---

### F-5. MEDIUM: README ships a broken image at the top of "Using the dashboard"

**Claim/evidence.** `README.md:147-148`: an HTML comment says "screenshot pending" and the very next line is `<img src="assets/screenshots/dashboard.png" ...>`. `assets/screenshots/` does not exist in the repo. On GitHub and npm this renders as a broken-image box in the most-viewed section of the README.

**Why it matters.** Pure embarrassment finding. First visual impression of a product whose pitch is "the portal is the product" is a broken image.

**Suggested fix.** Capture the dashboard and commit the PNG, or delete the `<img>` until it exists. Do not ship the tag with a known-broken reference.

---

### F-6. MEDIUM: Telemetry egress is undisclosed on every public surface

**What the code does.** `src/telemetry/emit.ts` posts four lifecycle events (`hive_installed`, `hive_uninstalled`, `hive_first_run`, `hive_updated`) to PostHog (`https://us.i.posthog.com`) with a closed five-key property set and an install-id `distinct_id`. The engineering is genuinely good: build-injected key that compiles to hard-disabled when unset, `HONEYCOMB_TELEMETRY=0` and `DO_NOT_TRACK` honored, dedupe ledger, 2s bounded fire-and-forget, no PII in the allow-list. `telemetry-egress.md` documents all of it thoroughly.

**The gap.** That doc is in the PRIVATE knowledge tree. The README, the public overview (`library/knowledge/public/overview/overview.md`), and the CLI's own output say nothing about telemetry. The public overview even answers "Does hive store my credentials?" but not "does it phone home." Meanwhile the README's enterprise cell sells "one origin, one boundary... without storing a thing," and the trust-boundaries doc calls the PostHog POST "the only outbound-to-internet call hive can ever make." True, but the user only learns that call exists by reading private docs or source.

**Why it matters.** An AGPL project aimed partly at enterprise, shipping opt-out (not opt-in) telemetry with zero public disclosure, is a predictable HN comment thread. The mitigation costs one README section.

**Suggested fix.** Add a short "Telemetry" section to README.md and the public overview: the four events, the five properties, the two opt-out env vars, and a pointer that unkeyed source builds emit nothing.

---

### F-7. LOW: README status section is stale and one badge is wrong for this product

**Claim vs reality.** README line 222: the proxy and service work "are in active development under PRD-001 and PRD-002, with the readiness splash, landing gate, and health rail lined up behind them." Per the ledger, PRD-001/002 are implemented and QA-verified; the gate, `/buzzing`, and health rail are implemented on main (F-2); the readiness splash was implemented AND retired. The status section undersells the actual state, the opposite of the usual sin, but still wrong. Separately, the hero badge `harnesses-6` (line 19) is Hivemind/Honeycomb branding; hive is a portal daemon and has no harness surface (README line 216 itself says "No MCP server, no SDK").

**Suggested fix.** Rewrite the status paragraph against `system-overview.md`'s "Program state" section (which is accurate), and drop or replace the harness badge.

---

### F-8. LOW: The gate's upstream fetches have no timeout

**Evidence.** `src/daemon/gate.ts:136,145`: every non-exempt HTML navigation performs `fetchFleetStatus` (doctor `status.json`) and, when healthy, `fetchSetupAuthenticated` (honeycomb `/setup/state`), serially, with no `AbortSignal.timeout`. A refused connection fails fast, but a hung loopback listener (wedged daemon that accepts and never responds) would stall every page load indefinitely. The auth fetch is tied to the client's abort signal, which helps only when the browser gives up.

**Suggested fix.** Wrap both gate fetches (and the fleet-status route's fetch) in `AbortSignal.timeout(1500)` or similar; a timeout already maps to the correct fail states (not ready -> `/buzzing`; auth failure -> `/login`).

---

### F-9. LOW: `uninstall-service` leaves hive's entry in doctor's registry

**Evidence.** `src/cli-commands.ts` / `src/install/registry.ts`: there is registration code but no deregistration code. After uninstall, doctor keeps probing `:3853/health` forever and may attempt restarts of a unit that no longer exists. Both `doctor-registration-and-lifecycle.md` and `cli-and-runbook.md` document this honestly as a known gap with a manual workaround.

**Why it matters (only) LOW.** It is documented, loopback-local, and not a privilege issue. But it is the kind of lifecycle asymmetry users hit and file issues about in week one.

**Suggested fix.** Add a `--deregister` flag (or make uninstall remove the entry by default) using the same atomic read-modify-write the upsert already has.

---

## What was checked and came back clean

Worth stating so the findings above read in proportion.

- **No storage client (the load-bearing boundary).** No deeplake/activeloop import anywhere under `src/`; `package.json` runtime deps are exactly `hono`, `@hono/node-server`, `react`, `react-dom`, `zod`. Matches PRD-001 c-AC-5 and nectar ADR-0004 decision #2.
- **Proxy correctness.** `src/daemon/proxy.ts`: owner resolution (`/api/hive-graph` to nectar, all else honeycomb), loopback re-check, `redirect: "error"`, request-header strip set (host + RFC 7230 hop-by-hop + content-length), response strip (hop-by-hop + framing), buffered request bodies, streamed response bodies (SSE rides through), fail-soft 502 per daemon. Matches ADR-0002 and `bff-proxy-federation.md` claim for claim.
- **Credential-free claim.** `grep -ri authorization src` returns only the two hop-by-hop strip entries plus one comment, exactly as `trust-boundaries.md` predicts. No token minting, storage, or injection found.
- **Env surface claim.** "Hive reads exactly two environment variables" holds: the only `process.env` reads are the telemetry opt-outs in `emit.ts`.
- **Route table order.** `server.ts` registers gate first, assets, content-negotiated `/health`, `/api/fleet-status`, `/api/registered-services`, `/api/telemetry/stream`, then the catch-all proxy, then the shell fallback last. Matches the table in `landing-gate-and-routing.md` exactly.
- **Gate mechanics.** Hard-coded redirect literals only (no open-redirect path), exempt screens checked before precedence (loop-proof), fail-closed auth on every failure mode, client-abort threading. Matches ADR-0004.
- **Fleet status + readiness surfaces.** `fleet-status.ts` matches PRD-002a fs-AC-1..10 including the 200 fail-soft body and normalized output shape. `/buzzing` reuses the same `isFleetReady()` and hard-navigates to `/` so the server re-decides. Telemetry relay pipes doctor's SSE bytes with no buffering and abort propagation. Five-state derivation is pure, per-service, and shared.
- **CLI and service lifecycle.** Four verbs as documented; per-OS units with restart-on-crash and boot-on-login; legacy `thehive` migration; idempotent atomic registry upsert. Matches `doctor-registration-and-lifecycle.md`.
- **Release train.** `ci.yaml` (three-OS matrix: typecheck, test, build, pack dry-run) and `release.yaml` (OIDC trusted publishing, tag/version guard, dry-run default on manual dispatch) exist and close PRD-001's m-AC-5. npm publish pending the documented one-time manual bootstrap (`published: false` in the superproject manifest).
- **Knowledge base.** The eleven deep-dive docs were spot-checked against source and are accurate, including the self-reported paperwork drift. The one Superseded doc (`portal-readiness-splash.md`) is correctly labeled with pointers to current behavior.

---

## Traceability

Note up front: `library/requirements/completed/` is empty, so there are no formally completed PRDs to trace. The table below covers the two in-work PRDs (both effectively done per their ledgers) and the module-level ACs of the three implemented-but-backlogged PRDs.

### PRD-001 (in-work; ledger 26/27 VERIFIED)

| AC | Status | Notes |
|---|---|---|
| m-AC-1, a-AC-1..7 (process, /health, lock, port, pure construction) | Met | `server.ts`, `lock.ts`, `constants.ts`; tests present. `/health` now content-negotiated (PRD-005b), JSON contract unchanged for probes. |
| m-AC-2, a-AC-3 (shell on socket bind, no workload wait) | Met at the process level | The socket binds unconditionally. But note F-1: the gate now redirects unhealthy-fleet loads to `/buzzing`, so "shell renders regardless of workload health" is true for the buzzing shell, not the dashboard. Deliberate per ADR-0004. |
| m-AC-3, b-AC-1..5 (migrated registry/pages, copy-map) | Met | Routes have since grown (`/hive-graph`, `/health`), which is evolution, not drift. |
| m-AC-4, c-AC-1..2, c-AC-4..5 (no Deep Lake, owner routing, zod degrade) | Met | Now server-side per ADR-0002 (mechanism changed after the QA report; boundary intact). |
| c-AC-3 (one daemon down degrades its panels only) | Partial | Data layer: met (wire empty states, per-daemon 502). Page level: broken by the aggregate gate on fresh loads (F-1). The QA report's Warning about the honeycomb-scoped `daemonUp` gate was mooted by the same-origin wire rather than fixed (F-4). |
| m-AC-5 (independent release train) | Met (late) | `ci.yaml` + `release.yaml`; ledger still says OPEN, another F-2 style paperwork lag. First npm publish pending manual bootstrap. |
| m-AC-6, m-AC-7, d-AC-1..8 (cutover, supervision, service unit, registration) | Met | Verified in `service/`, `install/registry.ts`; honeycomb cutover per the PRD-001 QA report. |

### PRD-002 (in-work; ledger 19/19 VERIFIED)

| AC group | Status | Notes |
|---|---|---|
| fs-AC-1..10 (fleet-status proxy, fail-soft, isFleetReady, tamper safety) | Met | `fleet-status.ts` and `fleet-readiness.ts` match the spec, including the redirect pin remediation. Caveat: fs-AC-6/7's aggregate rule is the root of F-1. |
| rs-AC-1..9 (ReadinessSplash wraps SetupGate, polling, sticky gate) | Superseded, not met as written | `readiness-splash.tsx` and its tests were deleted by the PRD-003 work. Intent (never show "First time setup" while the fleet boots) is preserved and strengthened by the server gate + `/buzzing`. PRD needs a superseded annotation (F-3). |
| ac-AC-1..8 (consolidated acceptance) | Intent met via successors | ac-AC-1/4/5 now enforced server-side (stronger than specified); ac-AC-7 pins the aggregate rule F-1 recommends changing. |

### PRD-003 module ACs (backlog folder; implemented, no QA close-out)

| AC | Status | Evidence |
|---|---|---|
| Unhealthy fleet: any deep link redirects to /buzzing server-side | Met | `gate.ts:136-139`; `tests/daemon/gate.test.ts` |
| Healthy + no credential: redirect to /login | Met | `gate.ts:145-148`, `setup-auth.ts` fail-closed |
| Authenticated + healthy: `/` is the dashboard, never blank, never /dashboard | Met | shell catch-all + `matchRoute` fallback to Dashboard |
| /buzzing and /login exempt, no redirect loops | Met | `GATE_EXEMPT_ROUTES` checked before precedence |
| /login renders device flow via proxied /setup/login; auth bit flips gate | Met | `LoginScreen` in `setup-gate.tsx`; hard-navigate to `/` on authenticated |
| All former hash routes reachable as paths | Met | `router.tsx` (`usePathRoute`), `tests/dashboard/router.test.tsx` |
| Refresh/deep link re-runs identical server precedence | Met | gate is stateless middleware per request |

### PRD-004 module ACs (backlog folder; implemented, no QA close-out)

| AC | Status | Evidence |
|---|---|---|
| One tile per registered service; silent services get `starting` | Met | `/api/registered-services` + `applyRegisteredNames` |
| Five states map to five distinct bee SVGs | Met | `service-icons.tsx`, `tests/dashboard/service-icons.test.tsx` |
| Near-real-time tile updates over SSE | Met | telemetry relay + `useFleetTelemetry` |
| SSE unavailable: REST fallback, no blanking | Met | `applyRestFallback`, 2s poll |
| One bad service flips only its own tile | Met within /buzzing | Per-service derivation never reads siblings. Portal-wide, F-1 undercuts the same principle at the gate. |
| Ready: transition using the same readiness rule as the gate | Met | `buzzing-screen.tsx:116,139` (`isFleetReady`, `location.assign("/")`) |
| Deterministic single shared state mapping | Met | `deriveServiceState`, `tests/shared/service-status.test.ts` |

### PRD-005 module ACs (backlog folder; implemented, no QA close-out)

| AC | Status | Evidence |
|---|---|---|
| Health rail on every route, live via SSE | Met | `HealthRail` mounted in `Shell` (`app.tsx:212`) |
| Rail survives SSE loss via REST fallback | Met | shared hook behavior |
| /health per-service counters since restart | Met | generic over metric keys, `humanizeMetricKey` |
| /health Deep Lake connection state + last comms | Met | `deeplake` block of the fleet model |
| /health live logs with selectable verbosity, no reload | Met | `filterLogsByVerbosity`, client-side re-filter |
| Bounded memory (windowed logs, no unbounded series) | Met | `LOG_RING_BUFFER_CAP = 500`, current-state-only services |
| Browser never opens doctor directly | Met | relay is the only doctor SSE consumer; fixed loopback constant |

---

## Recommended order of attack

1. F-1: decide the gate rule (required peers vs aggregate) and implement or formally accept. Everything else in this report is housekeeping; this one changes runtime behavior users will hit.
2. F-2 + F-3: PRD lifecycle sweep and retroactive security/QA close-outs for 003/004/005.
3. F-5 + F-6 + F-7: README pass (screenshot, telemetry section, status paragraph, badge).
4. F-4: decide the fate of the health strip and fix the stale comments.
5. F-8 + F-9: gate fetch timeouts; uninstall deregistration.
