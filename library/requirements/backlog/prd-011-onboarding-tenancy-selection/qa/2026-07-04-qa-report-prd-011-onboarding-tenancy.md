# QA Report: PRD-011 Onboarding tenancy selection and active-tenancy visibility

**Plan document:** `library/requirements/backlog/prd-011-onboarding-tenancy-selection/` (index + 011a + 011b + 011c)
**Audit date:** 2026-07-04
**Base branch:** `main` (HEAD `b1ba031`)
**Head:** `feature/prd-011-onboarding-tenancy` (all changes uncommitted, working tree)
**Auditor:** quality-worker-bee

**Ordering:** security-worker-bee ran first for this cycle (report: `library/qa/security/2026-07-04-security-audit-prd-011-onboarding-tenancy.md`, no Critical/High). Correct order confirmed.

**Dispatched fix applied by this audit (exception to report-don't-fix, named in the dispatch):** security finding F-4 (daemon event schema rejects the new tenancy funnel events) was remediated in-repo before this report was written. See "F-4 disposition" below. Gates were re-run after the fix: `npm run typecheck` clean, `npm test` 428/428 (423 baseline + 5 new AC tests).

## Summary

> **SUPERSEDED BY RE-AUDIT (same day): final verdict PASS WITH WARNINGS.** C-1 was remediated and re-verified; see the "Re-audit (2026-07-04, post-remediation)" section at the end of this report. The body below is preserved as the first-pass snapshot.

**Verdict (first pass): BLOCKED.** One Critical: the gate's tenancy redirect target dead-ends. `createPortalGate` correctly 302s an authenticated, tenancy-unconfirmed operator to `/onboarding` (tg-AC-1..4 all pass with AC-named tests), but a plain navigation to `/onboarding` carries no `?t=` onboarding token, so `OnboardingScreen` renders the terminal `MissingTokenNotice` ("This setup link has expired... re-run the installer") instead of resuming at the tenancy step. That leaves tg-AC-8 unmet in the redirect path and ts-AC-10 reachable only through a full bootstrap re-run, contradicting the index flowchart ("tenancy unconfirmed -> /onboarding resumes at the tenancy step") and PRD-011c's stated rationale for choosing `/onboarding` as the target. Everything else is in strong shape: the tenancy step, wire clients, fail-closed gate read, and honest display states match the frozen honeycomb 073c contract field-for-field, and the dispatched F-4 fix now has the three tenancy funnel events accepted end to end with acceptance-asserting tests. Fix the Critical (a tokenless resume path on `/onboarding`) and this branch is shippable with the listed warnings as follow-ups.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ⚠️ | 28 of 31 sub-ACs implemented with AC-named passing tests; ts-AC-10/tg-AC-8 broken in the tokenless redirect path (Critical); several display ACs verified in code but untested at render level |
| Correctness   | ⚠️ | Gate precedence, fail-closed read, single-org confirm, canCreate gating, and select-ack handling all correct; the redirect-target dead-end is the one behavioral defect |
| Alignment     | ✅ | Contract mirrored field-for-field against the canonical honeycomb 073c shape (`pending`, `selected`, `authenticated`, `org`, `workspace`, `autoSelected?`; select body `{ orgId, workspaceId }` asserted byte-exact in a test); redirect literals fixed; `/buzzing` untouched |
| Gaps          | ⚠️ | `ActiveTenancyDisplay` and the nectar panel tenancy line have no render-level tests; tg-AC-7's non-loopback outcome undriven; ts-AC-12 untested |
| Detrimental   | ✅ | No fabricated `local · default` anywhere on the new surfaces; no console output; fail-soft parse discipline consistent; one unused duplicate wire surface noted as a suggestion |

## Gate outputs

| Gate | Result |
|---|---|
| `npm run typecheck` | Clean (exit 0), before and after the F-4 fix |
| `npm test` (baseline, pre-fix) | 60 files, 423/423 passed |
| `npm test` (final, post-fix) | 60 files, 428/428 passed |
| Lints on edited files | Clean |
| Em/en dash scan of edited files | Clean |

## F-4 disposition: FIXED HERE (in-repo, hive-side)

The closed onboarding-event schema lives in hive, not honeycomb: `OnboardingEventBodySchema` / `UI_FUNNEL_EVENTS` in `src/daemon/installer/funnel-telemetry.ts`, consumed by hive's own `POST /api/onboarding/event` route (`src/daemon/installer/routes.ts:229-239`). No cross-repo handoff was needed. Changes:

- `src/daemon/installer/funnel-telemetry.ts:31-39` - `tenancy_shown`, `tenancy_selected`, `workspace_created` added to `UI_FUNNEL_EVENTS`; a dedicated `TenancySelectedBodySchema` validates the UI's exact properties as closed enums (`orgCount: single|few|many`, `singleOrgConfirm: true|false`); `tenancy_shown`/`workspace_created` join the simple-event enum; `recordUiEvent` handles all three (the exhaustive-never switch enforced this at compile time).
- `src/telemetry/emit.ts:169-186,121-126,200-215` - the chokepoint's `OnboardingFunnelEvent` vocabulary gains the three events; the closed property allow-list gains `org_count` and `single_org_confirm` (bucketed enum and flag only, never an org/workspace id or name, preserving the stricter-than-baseline posture the security audit noted).
- `tests/daemon/installer/funnel-telemetry.test.ts` - three new ts-AC-13 tests assert ACCEPTANCE (202, not 400) and emission for all three events, assert the forwarded properties stay inside the closed allow-list, and assert a body carrying a raw org name/id is rejected 400 with nothing emitted.
- `tests/dashboard/tenancy-step.test.tsx` - two new ts-AC-13 tests assert the UI emits `tenancy_selected` with the bucketed properties and `workspace_created` after a `created: true` ack.

ts-AC-13 is now genuinely met: the events are emitted by the UI, accepted by the daemon route, and forwarded through the chokepoint with the closed extras.

## Critical Issues (must fix)

- [x] **(CLOSED in re-audit)** **C-1: The gate's `/onboarding` redirect lands on the expired-link screen, not the tenancy step (tg-AC-8 unmet; ts-AC-10 unreachable without a bootstrap re-run)**, `src/dashboard/web/onboarding/onboarding-screen.tsx:193-194,292` + `src/daemon/gate.ts:169-172`

  `createPortalGate` redirects an authenticated operator with `selected: false` to `/onboarding` (correct, tg-AC-1 test passes). But that navigation carries no `?t=` token, `useOnboardingToken` resolves `""`, and the screen renders the terminal `MissingTokenNotice` before the resume state machine ever runs. tg-AC-8 requires "the surface they end on is the onboarding flow's tenancy step with copy about selecting an org and workspace"; the surface actually ended on says "This setup link has expired... Re-run the installer." ts-AC-10's resume-at-tenancy logic (`onboarding-screen.tsx:216-224`) is implemented and correct, but only executes when a token is present, i.e. only after re-running the whole bootstrap, which is exactly the "no re-install, no re-login" friction the AC excludes. PRD-011c chose `/onboarding` as the redirect target precisely because "its detect logic resumes at the tenancy step for an installed, authenticated, unselected machine" (index, gate-redirect open question); that assumption does not hold tokenless. Recommended remediation: on a tokenless mount, before showing `MissingTokenNotice`, probe the token-free surfaces (`/api/onboarding/health` is token-free when no session is active, and `/setup/state` + `/setup/tenancy` are token-free by design, ts-AC-12); if the machine reads installed + authenticated + unselected, enter the tenancy phase directly (its whole data plane is `/setup/*`, no token needed; the fire-and-forget funnel events may 401 silently, or the event route can adopt the existing "detect" token mode). Add a ts-AC-10-named test for the tokenless resume.

  ```tsx
  // onboarding-screen.tsx:193-194, the token gate that fires before any resume logic
  const tokenReady = clientOverride !== undefined || (token !== null && token !== "");
  const tokenMissing = clientOverride === undefined && token === "";
  // :292
  if (tokenMissing) return <MissingTokenNotice />;
  ```

## Warnings (should fix)

- [ ] **W-1: `ActiveTenancyDisplay` has no render-level test (tv-AC-1/4/5 wiring unproven)**, `src/dashboard/web/active-tenancy-display.tsx:54-92`, `src/dashboard/web/app.tsx:150-155,245`

  The pure helpers (`deriveActiveTenancyLabel`, `formatActiveTenancyLabel`) carry the tv-AC-1/2/3 named tests, but the component itself, its hydrate-on-mount, the `refreshKey` re-hydrate on the honeycomb down-to-up transition, and the `switchFeedback?.kind === "persisted"` re-hydrate (tv-AC-5) are exercised by no test. A regression in any of those effects would pass the suite. Recommend a jsdom test rendering the component with a mock wire, asserting the testid renders each `data-tenancy-state`, and driving `refreshKey`/switch feedback.

- [ ] **W-2: The nectar panel tenancy line has no render-level test (tv-AC-6/7 unproven at the panel)**, `src/dashboard/web/pages/hive-graph.tsx:147-156,178-185`

  `formatNectarPanelTenancy` is tested (tv-AC-8 both branches), but no test asserts the `nectar-projects-tenancy` line renders when nectar is reachable, or that it is absent in the unreachable state (`!projectsWire.unreachable && hydrated` guard). `hive-graph-page.test.tsx` mocks `setupTenancy` but never queries the line.

- [ ] **W-3: tg-AC-7's non-loopback outcome is not driven by any test**, `src/daemon/setup-tenancy.ts:34-35`, `tests/daemon/setup-tenancy.test.ts`

  tg-AC-7 requires unit tests to drive all four outcomes: confirmed, unconfirmed, read failure, and non-loopback. The first three are covered (tg-AC-4/5 named tests); the `isLoopbackBaseUrl(base)` early-return false is untested (needs a registry fixture resolving honeycomb to a non-loopback base, the same pattern the setup-auth suite would use).

  ```ts
  const base = resolveDaemonBases({ registryPath: options.registryPath }).honeycomb;
  if (!isLoopbackBaseUrl(base)) return false; // untested branch
  ```

- [ ] **W-4 (carried from security F-2): fault-mode reload loop between the gate's fail-closed read and the step's short-circuit**, `src/dashboard/web/onboarding/tenancy-step.tsx:48-66`

  If the gate's server-side tenancy read persistently fails while the browser's proxied read reports `selected: true`, the flow cycles /onboarding -> `completeFlow()` -> `/` -> gate redirect -> /onboarding, re-firing `dashboard_reached` and `POST /api/onboarding/complete` each lap. The security audit classified it Low/no-security-impact and handed it here as a resilience follow-up: add a loop-breaker (e.g. a session-scoped "already completed" flag or a bounded retry/backoff before re-navigating).

## Suggestions (consider improving)

- [ ] **S-1: `wire.ts` duplicates the tenancy client surface with no production caller**, `src/dashboard/web/wire.ts:1958-1965,2638-2656`

  `setupTenancyOrgs`, `setupTenancyWorkspaces`, `setupTenancySelect`, and `setupTenancyCreateWorkspace` exist on `WireClient` but nothing outside tests calls them; the onboarding step uses `tenancy-client.ts` (per ts-AC-11) and the display surfaces use only `wire.setupTenancy()`. Two clients for the same five endpoints is drift waiting to happen; drop the four unused wire methods or consolidate on one client.

- [ ] **S-2: `SetupTenancySchema` omits the contract's optional `confirmedBy` field**, `src/dashboard/web/onboarding/tenancy-contracts.ts:27-34`

  The canonical 073c shape carries `confirmedBy?`; hive's schema (non-strict, so the field passes through unparsed) neither models nor uses it, and `autoSelected` is parsed but never consumed. Harmless today, but "mirrors field-for-field, pinned at implementation" argues for either modeling both or documenting the deliberate omission in the module header.

- [ ] **S-3: tg-AC-6's separate-fetch decision is not explicitly justified in code**, `src/daemon/gate.ts:167-172`

  The AC accepts one additional loopback fetch per gated navigation "explicitly justified as separate fetches". The gate takes that path but the comment does not say why (selected is not surfaced on `/setup/state`). One sentence at the call site closes the AC cleanly.

- [ ] **S-4: ts-AC-12 (no token on tenancy calls) is code-verifiable but untested**, `src/dashboard/web/onboarding/tenancy-client.ts:42-108`

  The client sends only `accept`/`content-type` headers; a small test asserting no `x-onboarding-token` header rides any tenancy request would pin the posture.

- [ ] **S-5: ts-AC-5 has no named test**, `tests/dashboard/tenancy-step.test.tsx`

  The workspace-list behavior (every workspace listed, active choice required, no preselected `default`) is exercised inside the ts-AC-9 flow but carries no ts-AC-5-named assertion.

- [ ] **S-6 (carried from security F-3, cross-repo): create-workspace name lacks an upper length bound**, `src/dashboard/web/onboarding/tenancy-step.tsx:266-283`

  Enforcement point is honeycomb's `CreateWorkspaceBodySchema` (outside this repo); once a `.max(...)` lands there, mirror `maxLength` on this input. Tracked in the security report; repeated here so it survives the handoff.

## Plan Item Traceability

Status legend: ✅ met with AC-named passing test; ⚠️ implemented but test/coverage gap or partial; ❌ not met; 🟦 out of hive's verifiable scope (manual or cross-repo).

### PRD-011a (ts-AC-1..13)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| ts-AC-1 | Authenticated advances to `tenancy`, no terminal handoff from login | ✅ | `login-step.tsx:112-120`, `onboarding-screen.tsx:288-290` | Named tests in `login-step-tenancy.test.tsx` and `onboarding/login-step.test.tsx` |
| ts-AC-2 | Step hydrates `GET /setup/tenancy` first; `selected: true` short-circuits | ✅ | `tenancy-step.tsx:60-67` | Named test in `prd-011-tenancy.test.ts` |
| ts-AC-3 | Single-org confirm screen (name + id); zero-org honest error | ✅ | `tenancy-step.tsx:70-81,215-227` | Named test in `tenancy-step.test.tsx` |
| ts-AC-4 | Multi-org list, none preselected, choosing loads workspaces | ✅ | `tenancy-step.tsx:82,197-213` | Named test in `tenancy-step.test.tsx` |
| ts-AC-5 | Workspace list, active choice, no preselected `default` | ⚠️ | `tenancy-step.tsx:229-257` | Behavior correct; exercised inside ts-AC-9 flow but no named test (S-5) |
| ts-AC-6 | Create affordance only when `canCreate: true`; created ack selects | ✅ | `tenancy-step.tsx:258-290,134-149` | Client-level named test + new UI create test (added with F-4 fix) |
| ts-AC-7 | Zero workspaces + `canCreate: false` honest state with back affordance | ✅ | `tenancy-step.tsx:234-242` | Named test in `tenancy-step.test.tsx` |
| ts-AC-8 | `POST /setup/tenancy/select` with `{ orgId, workspaceId }`; advance only on `selected: true`; honest error otherwise | ✅ | `tenancy-client.ts:79-92`, `tenancy-step.tsx:113-132` | Body asserted byte-exact; error path renders `redactedReason`-derived string with dismiss+re-pick |
| ts-AC-9 | `dashboard_reached` -> `complete()` -> navigate, in order, relocated from login | ✅ | `tenancy-step.tsx:48-58`, `onboarding-screen.tsx:277-285` | `clearSelection()` moved with the terminal path as specified |
| ts-AC-10 | Re-entry resumes directly at the tenancy phase (no re-install, no re-login) | ❌ | `onboarding-screen.tsx:216-224` (resume logic), `:193-194,292` (token gate) | Resume logic implemented and correct, but only reachable with a `?t=` token; the gate's tokenless redirect lands on `MissingTokenNotice` (C-1). No test either way |
| ts-AC-11 | Wire client beside `onboarding-client.ts`, zod `.catch()` fail-soft, contract marked as mirror | ✅ | `tenancy-contracts.ts`, `tenancy-client.ts` | Named tests; module headers carry the pinned-at-implementation note |
| ts-AC-12 | Tenancy calls ride `/setup/*` with no token; no secret in any body | ⚠️ | `tenancy-client.ts:42-108` | Verified by inspection (plain fetch, no token header) and by the security audit; no named test (S-4) |
| ts-AC-13 | Funnel emits `tenancy_shown` / `tenancy_selected` (bucket + confirm flag) / `workspace_created` through `sendEvent` | ✅ | `tenancy-step.tsx:85-89,124-128,146`; daemon acceptance: `funnel-telemetry.ts:31-70,160-180` | Was the F-4 gap (daemon 400'd all three); FIXED in this audit with acceptance-asserting tests both sides |

### PRD-011b (tv-AC-1..8)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| tv-AC-1 | Shell chrome shows org + workspace on every route, sidebar collapsed or not | ⚠️ | `app.tsx:245`, `active-tenancy-display.tsx:54-92` | Label logic has a named test; the mounted component render is untested (W-1) |
| tv-AC-2 | Unreachable read shows "tenancy unavailable", never fabricated `local · default` | ✅ | `active-tenancy-display.tsx:19-27` | Named test; empty org/workspace names also degrade to unavailable |
| tv-AC-3 | "not linked" vs "tenancy not selected" distinguished | ✅ | `active-tenancy-display.tsx:20-22` | Named test |
| tv-AC-4 | Reads daemon persisted truth (`GET /setup/tenancy`); re-hydrates on down-to-up recovery | ⚠️ | `wire.ts:2627-2637`, `app.tsx:150-155` | Wired via `tenancyRefreshKey` beside `hydrateIdentity`; no test drives the recovery re-hydrate (W-1) |
| tv-AC-5 | Day-2 switch acknowledgment refreshes the readout without reload | ⚠️ | `active-tenancy-display.tsx:67-71` | Correctly keyed on `switchFeedback.kind === "persisted" && pending !== true`; untested (W-1) |
| tv-AC-6 | Panel names the tenancy its projects write to | ⚠️ | `hive-graph.tsx:147-156,178-185` | Implemented (body fields preferred, fleet-credential fallback labeled); render untested (W-2) |
| tv-AC-7 | Unreachable panel shows no tenancy line | ⚠️ | `hive-graph.tsx:147-149` | `!projectsWire.unreachable && hydrated` guard correct; render untested (W-2) |
| tv-AC-8 | Lenient body tenancy fields with labeled fleet-credential fallback | ✅ | `wire.ts:973-980`, `active-tenancy-display.tsx:95-109` | Two named tests (both branches) |

### PRD-011c (tg-AC-1..10)

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| tg-AC-1 | Healthy + authed + unconfirmed 302s to fixed `/onboarding` literal, after health and auth | ✅ | `gate.ts:167-172` | Named test; g-AC-11 open-redirect test extended to the third target |
| tg-AC-2 | Health first, auth second; tenancy never runs in either redirect branch | ✅ | `gate.ts:150-165` | Two named tests using throwing tenancy fetches to prove non-execution |
| tg-AC-3 | All three pass -> `next()` serves | ✅ | `gate.ts:174-176` | Named test |
| tg-AC-4 | Any read fault reads unconfirmed -> `/onboarding`; no fault path serves the dashboard | ✅ | `setup-tenancy.ts:30-53`, `gate.ts:169-172` | Named tests: network error, non-OK, malformed JSON, plus gate-level throw |
| tg-AC-5 | Read mirrors `fetchSetupAuthenticated`: `resolveDaemonBases`, loopback re-check, `redirect: "error"`, signal threaded, `.catch()` zod, false on failure | ✅ | `setup-tenancy.ts:11-53` | Construction verified line-for-line against `setup-auth.ts:49-76`; signal-threading test present |
| tg-AC-6 | Coalesce or explicitly justify separate fetches | ✅ | `gate.ts:162-172` | Separate fetch taken (the accepted default; `selected` is not on `/setup/state`); justification comment missing (S-3) |
| tg-AC-7 | Injectable fetch seam; tests drive confirmed / unconfirmed / failure / non-loopback | ⚠️ | `gate.ts:112-113,129`, `server.ts:37-38,114` | Seam present and threaded; three of four outcomes driven, non-loopback undriven (W-3) |
| tg-AC-8 | Unconfirmed operator ends on the tenancy step; `/buzzing` unchanged | ❌ | `onboarding-screen.tsx:292` | `/buzzing` untouched (verified); but the tokenless redirect ends on `MissingTokenNotice`, not the tenancy step (C-1) |
| tg-AC-9 | Unhealthy + unconfirmed: health wins, then buzzing's hard nav re-runs the gate into the tenancy redirect | ✅ | `gate.ts:150-172`, `buzzing-screen.tsx` (untouched) | Health-wins proven by the tg-AC-2 throwing-fetch test; flow-through is structural |
| tg-AC-10 | No tenancy state in `fleet-readiness.ts`, `use-fleet-telemetry.ts`, health rail, buzzing tiles | ✅ | grep-verified this audit | Zero tenancy references in all four modules; criterion is audit-after-implementation, satisfied here |

### Index module ACs and non-goals

| # | Plan Requirement | Status | Notes |
|---|---|---|---|
| IDX-1 | `tenancy` phase entered on authenticated; nav to `/` only after acknowledged `selected: true` | ✅ | ts-AC-1/8/9 |
| IDX-2 | Multi-org picker / single-org confirm, then workspace list | ✅ | ts-AC-3/4/5 |
| IDX-3 | Create-new only when `canCreate: true` | ✅ | ts-AC-6 |
| IDX-4 | Honest errors with retry; never advance on failure, never fabricate | ✅ | ts-AC-3/7/8 |
| IDX-5 | Shell chrome shows active tenancy on every route, honest degradation | ⚠️ | tv-AC-1..5 (render-level coverage gap, W-1) |
| IDX-6 | Nectar panel shows tenancy with honest fallback | ⚠️ | tv-AC-6..8 (render-level coverage gap, W-2) |
| IDX-7 | Gate: health -> auth -> tenancy; unselected redirects to `/onboarding`; fail-closed read | ✅ | tg-AC-1..5; redirect target dead-end tracked as C-1 under tg-AC-8 |
| IDX-8 | Tenancy-wait distinct from fleet-unhealthy; buzzing means fleet health only | ⚠️ | Distinct copy and routes implemented; unmet in the tokenless path (C-1) |
| IDX-9 | Dogfood protocol passes on the owner's Windows machine incl. Deeplake write probe | 🟦 | Manual, out of this audit's reach; requires the parallel honeycomb daemon branch. Note: step 6's "flow resumes at the tenancy step on refresh" will surface C-1 |
| NG-1 | Daemon-side endpoints not implemented in hive | ✅ | hive proxies only; verified against fakes per the frozen 073c contract |
| NG-2 | Day-2 scope switcher unchanged | ✅ | `scope-context.tsx` untouched by this branch |
| NG-3 | Workspace creation optional, gated | ✅ | ts-AC-6 |
| NG-4 | Nectar-side body changes out of scope; lenient parse either way | ✅ | tv-AC-8 |
| NG-5/6 | No multi-account flows; local-mode loopback only | ✅ | No such surface added; gate read loopback-pinned |

## Files Changed

- `src/daemon/gate.ts` (M), gate precedence gains the third (tenancy) check with the fixed `/onboarding` literal and the injectable fetch seam
- `src/daemon/installer/funnel-telemetry.ts` (M, by this audit), F-4 fix: three tenancy events registered in the closed event schema and emitter
- `src/daemon/server.ts` (M), threads `setupTenancyFetch` into `createPortalGate`
- `src/daemon/setup-tenancy.ts` (A), fail-closed `fetchTenancySelected` mirroring `setup-auth.ts`
- `src/dashboard/web/active-tenancy-display.tsx` (A), shell readout component + label/panel-line helpers
- `src/dashboard/web/app.tsx` (M), mounts `ActiveTenancyDisplay` in the chrome bar; tenancy refresh key on honeycomb recovery
- `src/dashboard/web/onboarding/contracts.ts` (M), `ONBOARDING_UI_EVENTS` gains the three tenancy events
- `src/dashboard/web/onboarding/login-step.tsx` (M), terminal handoff removed; authenticated reports up via `onAuthenticated`
- `src/dashboard/web/onboarding/onboarding-screen.tsx` (M), `tenancy` phase, resume-at-tenancy branch, relocated terminal handoff
- `src/dashboard/web/onboarding/tenancy-client.ts` (A), the `/setup/tenancy/*` fail-soft client (no token)
- `src/dashboard/web/onboarding/tenancy-contracts.ts` (A), zod mirror of the canonical 073c contract
- `src/dashboard/web/onboarding/tenancy-step.tsx` (A), the org/workspace selection step (picker, confirm, create, errors, funnel events)
- `src/dashboard/web/pages/hive-graph.tsx` (M), nectar panel tenancy line with fleet-credential fallback
- `src/dashboard/web/wire.ts` (M), `setupTenancy` read (+ unreachable flag) plus four currently-unused tenancy methods (S-1); lenient nectar body tenancy fields
- `src/telemetry/emit.ts` (M, by this audit), F-4 fix: event vocabulary + closed `org_count`/`single_org_confirm` extras
- `tests/daemon/gate.test.ts` (M), tg-AC-1..4 named tests; g-AC-11 extended
- `tests/daemon/installer/funnel-telemetry.test.ts` (M, by this audit), three ts-AC-13 acceptance tests
- `tests/daemon/server.test.ts` (M), gate-pass fixtures gain the selected-tenancy fetch
- `tests/daemon/setup-tenancy.test.ts` (A), tg-AC-4/5 fail-closed read tests
- `tests/dashboard/copy-map.test.ts` (M), file census 49 -> 53
- `tests/dashboard/hive-graph-page.test.tsx` (M), wire mock gains `setupTenancy`
- `tests/dashboard/host.test.ts` (M), gate-pass fixtures gain the selected-tenancy fetch
- `tests/dashboard/login-step-tenancy.test.tsx` (A), ts-AC-1 handoff test
- `tests/dashboard/onboarding/login-step.test.tsx` (M), ob-AC-15 terminal test rewritten as ts-AC-1
- `tests/dashboard/prd-011-tenancy.test.ts` (A), contracts, display helpers, and tenancy client (ts-AC-2/6/8/11, tv-AC-1/2/3/8)
- `tests/dashboard/shell-connectivity-gate.test.tsx` (M), wire mock gains `setupTenancy`
- `tests/dashboard/tenancy-step.test.tsx` (A; extended by this audit), ts-AC-3/4/7/9 plus two ts-AC-13 emission tests

---

# Re-audit (2026-07-04, post-remediation)

**Auditor:** quality-worker-bee (same day, same working tree, still uncommitted)
**Scope:** re-verify C-1 and the first-pass warnings/suggestions against the remediated code; re-run gates; check for regressions. No code was modified by this re-audit.

## Final verdict: PASS WITH WARNINGS

C-1 is genuinely closed. All first-pass warnings W-1/W-2/W-3 and suggestions S-1/S-3/S-4/S-5 are closed with real render-level or behavior-level tests; S-2 is closed by the contract reconciliation (`autoSelected` removed, `confirmedBy` added, fail-soft and XSS-safe). The F-4 fix from the first pass is intact and its tests still run. Gates are green: `npm run typecheck` clean, `npm test` 62 files, 446/446 passed (428 at the first-pass close, +18). What remains below the PASS line: W-4 (the fault-mode reload loop, not claimed and not remediated) stays an open Warning, S-6 stays a deferred cross-repo item, the dogfood protocol (IDX-9) remains manual, and two new Suggestion-level observations were found on the new tokenless path. None of these blocks ship.

## C-1 closure assessment (re-attacked)

The fix is a tokenless probe effect in `OnboardingScreen` (`onboarding-screen.tsx:299-338`): when `tokenMissing`, it calls `wireClient.setupState()` and `wireClient.setupTenancy()` in parallel and routes on daemon truth. Each attack angle:

1. **Does the gate-redirect shape actually reach the tenancy step and complete selection?** Yes. `tests/dashboard/onboarding/tokenless-tenancy-resume.test.tsx:58-77` mounts tokenless (jsdom's default URL carries no `?t=`, exactly the redirect shape), asserts the `onboarding-tenancy-step` testid renders, asserts the `onboarding-missing-token` testid never does, then walks confirm-org -> pick-workspace -> asserts `selectTenancy("o", "w")` was called and the terminal handoff fired. tg-AC-8's required landing surface and ts-AC-10's live resume are both proven end to end.
2. **Does not-authenticated still fall to the genuine expired notice?** Yes. The probe routes `!setupState.authenticated` to `"expired"` (`onboarding-screen.tsx:315-318`); test at `:79-86` asserts the notice renders and the tenancy step does not.
3. **Does a failed/unreachable probe fabricate a resume?** No. The `"tenancy"` route requires `authenticated: true` from the actual read. The production wire methods are structurally fail-soft and never throw: `setupState` degrades to `FRESH_SETUP_STATE` (`authenticated: false`, `wire.ts:2598-2603`) and `setupTenancy` catches everything into `UNREACHABLE_SETUP_TENANCY` (`authenticated: false`, `wire.ts:2610-2623`), so any fault reads as not-authenticated and lands on the honest notice. Test at `:99-108` pins the degraded-probe route. (A literal promise rejection is impossible with the production client; see N-2 below for the belt-and-braces note.)
4. **authenticated + selected (stale bookmark)?** Hands straight back to `/` via `handleTenancyComplete` (`onboarding-screen.tsx:319-324`), deliberately firing no funnel event; test at `:88-97`. The gate then serves the dashboard (`selected: true`).
5. **Token-bearing path unchanged?** Yes; the probe effect is gated on `tokenMissing` (`onboarding-screen.tsx:310`) and the original resume branch (`:223-232`) is untouched.

**C-1: CLOSED.** tg-AC-8 and ts-AC-10 now pass with named tests.

## Per-AC deltas since the first pass

| AC | First pass | Now | Evidence |
|---|---|---|---|
| ts-AC-5 | ⚠️ no named test | ✅ | `tenancy-step.test.tsx:72-100`: both workspaces listed by display name, `default` gets no special treatment, `selectTenancy` not called before an active click |
| ts-AC-10 | ❌ (C-1) | ✅ | Tokenless resume completes selection end to end (`tokenless-tenancy-resume.test.tsx:58-77`) |
| ts-AC-12 | ⚠️ no named test | ✅ | `prd-011-tenancy.test.ts:139-160`: all five tenancy calls carry only `accept`/`content-type`, never `x-onboarding-token` or `authorization` |
| tv-AC-1 | ⚠️ helper-only | ✅ | Mounted render test (`active-tenancy-display.test.tsx:48-54`) |
| tv-AC-4 | ⚠️ untested wiring | ✅ | `refreshKey` re-hydrate driven (`active-tenancy-display.test.tsx:71-86`) |
| tv-AC-5 | ⚠️ untested wiring | ✅ | Persisted-switch re-hydrate driven, including the pending-switch no-op (`active-tenancy-display.test.tsx:88-122`) |
| tv-AC-6 | ⚠️ render untested | ✅ | Panel line render: fleet-credential fallback and body-fields-preferred (`hive-graph-page.test.tsx:282-303`) |
| tv-AC-7 | ⚠️ render untested | ✅ | No tenancy line in the unreachable state (`hive-graph-page.test.tsx:305-312`) |
| tg-AC-6 | ✅ (comment missing) | ✅ | Separate-fetch justification now in code (`gate.ts:167-172`), S-3 closed |
| tg-AC-7 | ⚠️ non-loopback undriven | ✅ | Resolver mocked (`vi.mock` hoisted), non-loopback base returns false with the fetch asserted never called (`setup-tenancy.test.ts:54-61`) |
| tg-AC-8 | ❌ (C-1) | ✅ | All four tokenless routes tested; the unconfirmed operator ends on the tenancy step |
| ts-AC-13 / F-4 | ✅ (fixed first pass) | ✅ unchanged | Schema, emitter, and all five tests intact (`funnel-telemetry.ts:31-71,174-185`); suite green |

Suggestion deltas: S-1 closed (the four unused wire methods removed; `setupTenancy` is now the only tenancy method on `WireClient`, with explicit no-drift comments, `wire.ts:29-32,1942-1948`). S-2 closed by reconciliation: `autoSelected` dropped from the schema, `confirmedBy: z.enum(["selection","grandfathered"]).optional().catch(undefined)` added (`tenancy-contracts.ts:25-34`). S-4/S-5 closed (the named tests above). S-6 remains deferred (honeycomb-side `CreateWorkspaceBodySchema` max length, cross-repo).

**`confirmedBy` contract safety:** verified. The field is a closed two-value zod enum, `.optional().catch(undefined)`, so a malformed or hostile value degrades to absent and can never fail the read (fail-soft confirmed). The "(grandfathered)" hint is built by `formatActiveTenancyLabel` from that enum, not from any remote string, and renders exclusively as a React text child (`{text}`, `active-tenancy-display.tsx:97`), so there is no XSS path even hypothetically. A mounted test covers the hint (`active-tenancy-display.test.tsx:124-129`).

## Still open (carried forward)

- [ ] **W-4 (Warning, carried): fault-mode reload loop**, `src/dashboard/web/onboarding/tenancy-step.tsx:48-66`. Not claimed in the remediation and unchanged: if the gate's server-side read persistently fails while the browser's read reports `selected: true`, the client still cycles select-complete -> `/` -> gate redirect -> `/onboarding`. Note the new tokenless selected-route (`handleTenancyComplete`) deliberately fires no funnel events, so the loop is quieter there, but no loop-breaker or backoff exists. Security classified it Low; it stays a should-fix resilience item.
- [ ] **S-6 (Suggestion, cross-repo): create-workspace name length bound**, enforcement point honeycomb `CreateWorkspaceBodySchema`; mirror `maxLength` client-side once it lands.
- **IDX-9 (deferred, manual): the dogfood protocol** on the owner's Windows machine, including the Deeplake write probe, still requires the parallel honeycomb daemon branch and cannot be executed by this audit.

## New findings (this re-audit)

- [ ] **N-1 (Suggestion): funnel events are silently dropped on the tokenless resume path**, `src/dashboard/web/onboarding/onboarding-screen.tsx:335` + `src/dashboard/web/onboarding/onboarding-client.ts:72-74` + `src/daemon/installer/routes.ts:229-231`

  In the tokenless branch, `TenancyStep` receives `client = createOnboardingClient("")`; `tokenHeaders("")` omits the token header, and the event route guards with token mode `"always"`, so `tenancy_shown`, `tenancy_selected`, `dashboard_reached`, and the `complete()` beacon all 401 and are swallowed for gate-redirect resumes. Fail-soft and harmless to the operator (all calls are fire-and-forget or best-effort), but the funnel undercounts exactly the resume cohort PRD-011 creates. Either accept the loss explicitly (a comment) or move the event route to the existing `"detect"` token mode.

- [ ] **N-2 (Suggestion): the tokenless probe IIFE has no rejection handler**, `src/dashboard/web/onboarding/onboarding-screen.tsx:312-326`

  The probe relies on the wire client's structural never-throw guarantee (which holds for the production client, verified at `wire.ts:2598-2603,2610-2623`). If a future wire implementation ever rejected, the screen would strand on the loading placeholder with an unhandled rejection instead of the expired notice. A one-line `.catch(() => setTokenlessResume("expired"))` makes the fail-closed routing independent of that guarantee.

## Re-audit gate outputs

| Gate | Result |
|---|---|
| `npm run typecheck` | Clean (exit 0) |
| `npm test` | 62 files, 446/446 passed |
| Em/en dash scan (remediated files) | Clean |
| Working tree | Unchanged by this re-audit (report file only) |

## Files changed since the first-pass audit (remediation delta)

- `src/daemon/gate.ts` (M), tg-AC-6 separate-fetch justification comment added
- `src/dashboard/web/onboarding/onboarding-screen.tsx` (M), the C-1 tokenless probe effect + `tenancyClient` test seam
- `src/dashboard/web/onboarding/tenancy-contracts.ts` (M), `autoSelected` removed, `confirmedBy` added (reconciled contract)
- `src/dashboard/web/active-tenancy-display.tsx` (M), `confirmedBy` carried into the label with the "(grandfathered)" hint
- `src/dashboard/web/wire.ts` (M), four unused tenancy methods removed; `setupTenancy` documented as the only WireClient tenancy read
- `tests/dashboard/active-tenancy-display.test.tsx` (A), six mounted tests (tv-AC-1..5 + grandfathered hint)
- `tests/dashboard/onboarding/tokenless-tenancy-resume.test.tsx` (A), four C-1 route tests (tg-AC-8 / ts-AC-10)
- `tests/dashboard/hive-graph-page.test.tsx` (M), tv-AC-6/7 render tests added
- `tests/daemon/setup-tenancy.test.ts` (M), tg-AC-7 non-loopback test via mocked resolver
- `tests/dashboard/tenancy-step.test.tsx` (M), ts-AC-5 named test added
- `tests/dashboard/prd-011-tenancy.test.ts` (M), ts-AC-12 named test added; helper tests updated for the reconciled contract
