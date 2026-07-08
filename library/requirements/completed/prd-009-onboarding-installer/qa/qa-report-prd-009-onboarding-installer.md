# QA Report: PRD-009 Onboarding Installer (+ PRD-001 remnants, PRD-002 verification)

**Plan documents:**
- `hive/library/requirements/in-work/prd-009-onboarding-installer/` (index, prd-009a, prd-009b, prd-009c, prd-009d)
- `hive/library/requirements/in-work/prd-001-hive-portal-daemon/qa/qa-report-prd-001-hive-portal-daemon.md` (the two Warnings and one Suggestion this run closes)
- `hive/library/requirements/in-work/prd-002-portal-readiness-splash/` (index, prd-002a, prd-002b, prd-002c) + `qa/ac-verification-map-2026-07-03.md`
- `library/ledger/EXECUTION_LEDGER-onboarding-installer.md` (orchestration record, verified independently below, not taken on faith)

**Audit date:** 2026-07-03
**Base branch:** `main` (all three repos)
**Head:**
- hive: `feature/prd-009-onboarding-installer`
- the-apiary: `feature/install-surface-and-fleet-onboarding`
- honeycomb: `feature/move-install-surface-to-apiary`

**Auditor:** quality-worker-bee
**Ordering check:** `security-worker-bee` ran first on this branch set (0 Critical, 1 High fixed — the installer's query-token acceptance was widened past the SSE route, now restricted; 1 Medium deferred with rationale — the legacy `install.sh`/`install.ps1` `@latest` fallback, which PRD-009 explicitly preserves via bs-AC-7 and lists as a non-goal). Ordering is correct; this audit proceeds and does not re-flag the deferred Medium as a new gap.

## Summary

The onboarding installer implementation is complete and correct against all four PRD-009 sub-plans, and independently reproduces the ledger's own verification: `hive` typecheck is clean and its full suite passes 347/347 (including the security regression test for the fixed High), `honeycomb` typecheck is clean and its full suite passes 370/370 (4037 tests, 12 skipped, confirming the install-surface removal is clean), `install.sh` parses cleanly and its dry-run correctly exercises both the portal and legacy paths, `install.ps1` parses cleanly under real PowerShell (stronger evidence than the ledger's "pwsh unavailable" caveat), and `site/install/build.mjs` builds a full `dist/` including a byte-identical `hive-release.json`. All three PRD-001 close-out items (the per-daemon connectivity gate, the stale `CONVENTIONS.md` reference, the two-daemon isolation tests) are genuinely closed with passing tests, and a spot-check of ten PRD-002 verification-map rows (VERIFIED and SUPERSEDED) confirmed each cited mechanism and test are real and accurate. Two Warnings stand out: the Advanced picker's resume path can silently reinstall a product the operator explicitly deselected after an interruption, and a knowledge-doc edit made in this very run asserts hive "awaits its first npm publish" while the shipped `hive-release.json` already pins hive `published: true`. Neither blocks ship; recommend a fast-follow for the resume-subset gap and a one-line doc fix for the publish-status claim. **Verdict: PASS with Warnings.**

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | All in-scope ACs across 009a/b/c/d (19+17+6+8) implemented with code + passing tests; PRD-001's P1-W1/P1-S1/P1-S2 all closed; PRD-002's 19 VERIFIED / 16 SUPERSEDED dispositions spot-checked and confirmed honest. |
| Correctness   | ✅ | Load-bearing pieces verified directly: the three security mitigations (allowlist + server-side version resolution, Origin/Host, constant-time single-session token) with a regression test for the fixed High; the ~30s dwell hook never masks a failure; the device-code display reuses the exact `GuidedSetup` contract; the manifest resolver refuses rather than falls back to `@latest` on the new portal path; all nine funnel events fire through the one chokepoint with the closed allow-list; the per-owner connectivity gate isolates honeycomb vs. nectar correctly in both directions. |
| Alignment     | ⚠️ | File dispositions match the four sub-PRDs; the honeycomb removal is clean (`git status` shows exactly the moved trees as `D`, typecheck + full suite green). One stale-comment nit in `honeycomb/src/commands/install.ts` and a batch of fleet-status documentation-currency edits (harness counts, "production ready" framing) that sit outside any PRD-009/001/002 acceptance criterion, though they are low-risk and consistent with the release this run represents. |
| Gaps          | ⚠️ | The Advanced picker's deselected-product set has no server-side or client-side memory across a page reload; resuming a partial Advanced install can silently queue products the operator explicitly opted out of, an edge case the implementers documented in code comments but did not close. |
| Detrimental   | ⚠️ | One factual regression introduced by this run's own documentation pass: `hive/library/knowledge/private/infrastructure/release-train-and-manifest.md` now claims hive "awaits its first npm publish," but `hive-release.json` at the superproject root already pins hive `"published": true`. No code or test regressions found. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **Advanced-mode resume can silently reinstall a product the operator explicitly deselected**, `hive/src/dashboard/web/onboarding/contracts.ts:93-107`, `hive/src/dashboard/web/onboarding/onboarding-screen.tsx:147-165`

  `hasResumableInstall`/`remainingProducts` walk the fixed `FIXED_PRODUCT_ORDER` and treat every not-`installed` product as part of the resume queue, with no memory of which subset the operator actually chose in the Advanced picker (ob-AC-7). Concretely: an operator picks Advanced, deselects `nectar` (leaving it `not_installed` by design, never requested), the tab closes mid-install of `honeycomb`. On re-entry, `/onboarding` detects `honeycomb: install_in_progress` and `nectar: not_installed`, so `hasResumableInstall` is true and `installingOrHealth(remainingProducts(detection))` builds the queue `[honeycomb, nectar]` — `nectar` gets silently queued and installed even though the operator explicitly opted out of it via the picker (ob-AC-7's "confirming the selection enters the same guided flow for exactly the chosen products" is honored on the first pass but not preserved across a resume). This is flagged in the code's own module doc (`onboarding-screen.tsx:16-19`, `contracts.ts:96-100`) as a known limitation of "the given API contract has no server-side memory of which subset Advanced selected," and the ledger's log accepts it as documented behavior, but it is a real, user-visible behavior gap against ob-AC-7 combined with ob-AC-16 ("resumes from the first incomplete step" is not the same guarantee as "resumes only the originally-chosen step"), not merely a cosmetic one.

  Suggested: persist the confirmed Advanced subset (e.g., a query-string parameter or a token-keyed daemon-side record alongside the existing install state) so a resume walks the ORIGINAL selection, not the full fixed order.

  ```ts
  // contracts.ts:102-107 — the resumed queue can silently reintroduce a deselected product
  export function hasResumableInstall(detection: DetectResponse): boolean {
  	return remainingProducts(detection).some((p) => {
  		const state = detectionFor(detection, p).state;
  		return state === "install_in_progress" || state === "install_failed";
  	});
  }
  ```

- [ ] **A doc edit made in this run asserts hive still awaits its first npm publish, contradicting the shipped manifest**, `hive/library/knowledge/private/infrastructure/release-train-and-manifest.md:74`

  This run bumped the doc to v1.1 and rewrote its closing paragraph to say "the one remaining step is the first npm publish, which awaits the one-time trusted-publisher bootstrap below... when hive completes the npm bootstrap, the first thing that changes operationally is that its `published` flag flips to `true`." But `hive-release.json` at the superproject root (unmodified by this branch, already at HEAD before this run started) already reads `"hive": { "published": true, ... }`, and `hive/src/daemon/installer/manifest-snapshot.json` (this run's own bundled ship-time snapshot) agrees. The doc's own currency pass in this run updated the surrounding prose to "production ready" language but left this specific publish-status claim stale/incorrect, which will mislead the next reader into thinking hive is unpublished when the fleet manifest the installer itself resolves against says otherwise.

  Suggested: update the closing paragraph to reflect `published: true`, or drop the publish-status claim entirely if it is genuinely uncertain, rather than asserting a specific future event that has already happened per the manifest.

  ```md
  Hive is production ready and CI-covered on `main`, with its full portal PRD program shipped and
  tested in live scenarios; the one remaining step is the first npm publish, which awaits the
  one-time trusted-publisher bootstrap below.
  ```

## Suggestions (consider improving)

- [ ] **Fleet-status documentation-currency edits sit outside any PRD-009/001/002 acceptance criterion**, `honeycomb/library/knowledge/private/overview.md`, `honeycomb/library/knowledge/public/overview/what-is-honeycomb.md`, `honeycomb/README.md`(via `the-apiary/README.md`'s cross-repo status table), `the-apiary/library/knowledge/private/architecture/ADR-0001-*.md`, `ADR-0002-*.md`

  These edits update harness-support counts ("six" → "three supported, three in progress") and flip doctor/nectar/honeycomb to "production ready," none of which is called for by prd-009a/b/c/d, the PRD-001 Warnings, or the PRD-002 verification map. They are low-risk (prose only, no code) and coherent with the release story this run culminates in (hive's PRD program completing), so this is not a blocking concern, but it is out-of-scope churn per the plan's stated boundaries and worth a conscious sign-off rather than a silent pass.

- [ ] **`contracts.ts` duplicates `shared/onboarding-types.ts` field-for-field**, `hive/src/dashboard/web/onboarding/contracts.ts:1-11`

  The module doc explains this is deliberate (the UI and daemon agents built against the contract in parallel, with a documented later-integration pass planned), so this is not a defect, just standing duplication a future pass should collapse to avoid the two files drifting silently if one side's shape changes without the other.

- [ ] **Stale unqualified path reference in a comment**, `honeycomb/src/commands/install.ts:6, 82-83, 397`

  These comments still say `scripts/install/install.sh` / `scripts/install/install.ps1` without the the-apiary qualifier now that the scripts live in a different repository, unlike `CONVENTIONS.md` and the two knowledge docs this run did correct with full cross-repo links. No functional impact (comments only).

## Plan Item Traceability

### PRD-009 module acceptance criteria (index, roll-up)

| # | Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| m-1 | bootstrap installs only hive pinned, opens browser, prints exact fallback line, zero prompts | ✅ | `scripts/install/install.sh:1088-1183` (`run_portal_path`), `install.ps1` mirrors | Verified via dry-run: exact fallback line printed, no `read`/prompt in the path. |
| m-2 | `/onboarding` gate-exempt, detects fleet pre-doctor, short-circuits when healthy | ✅ | `hive/src/daemon/gate.ts:52-55`, `hive/src/daemon/installer/detection.ts:84-93`, `hive/src/dashboard/web/onboarding/onboarding-screen.tsx:147-165` | |
| m-3 | hero animates brand SVGs, exactly two verbatim buttons | ✅ | `hive/src/dashboard/web/onboarding/onboarding-hero.tsx` | |
| m-4 | cards: ~30s min dwell, staged progress, no percent bar, provenance copy | ✅ | `hive/src/dashboard/web/onboarding/{install-card,use-install-dwell,product-copy}.tsx/.ts` | |
| m-5 | allowlist + server-side version resolution + Origin/Host + token + argv npm | ✅ | `hive/src/daemon/installer/{security,manifest,token,spawn}.ts` | Security-fixed High regression-tested (`tests/daemon/installer/security.test.ts` is-AC-9 query-token case). |
| m-6 | SSE progress per telemetry-proxy pattern; per-product registration verbs | ✅ | `hive/src/daemon/installer/{routes,install-state}.ts`, `products.ts` | |
| m-7 | health check → device-code display → dashboard | ✅ | `hive/src/dashboard/web/onboarding/{health-view,login-step}.tsx` | |
| m-8 | full funnel event list, fleet telemetry posture | ✅ | `hive/src/daemon/installer/funnel-telemetry.ts`, `hive/src/telemetry/emit.ts` | |
| m-9 | failure honesty + resumability, no re-run of completed installs | ⚠️ | `hive/src/dashboard/web/onboarding/install-card.tsx`, `contracts.ts` | Failure honesty and completed-install short-circuit both verified; the Advanced-subset resume gap above is the one caveat. |

### PRD-009a: installer service and security

| # | Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| is-AC-1 | pre-doctor detection, hive-only machine reported correctly | ✅ | `src/daemon/installer/detection.ts:84-93` | `tests/daemon/installer/detection.test.ts` |
| is-AC-2 | closed per-product state set + version, from local evidence | ✅ | `detection.ts:29-71` | |
| is-AC-3 | non-allowlisted slug → 4xx, no spawn | ✅ | `routes.ts:128-130`, `products.ts:45-53` | |
| is-AC-4 | `packageName@version` resolved server-side from manifest only | ✅ | `manifest.ts:104-126`, `routes.ts:132-133` | |
| is-AC-5 | unpublished/unresolvable → refuse, never `@latest` | ✅ | `manifest.ts:43-46, 113-117`; `routes.ts:134-135` | |
| is-AC-6 | argv-array spawn, shell disabled | ✅ | `spawn.ts:67-93` (`shell: false` pinned) | `tests/daemon/installer/spawn.test.ts` |
| is-AC-7 | Origin validation (403; missing on non-GET rejected) | ✅ | `security.ts:41-44` | `tests/daemon/installer/security.test.ts` |
| is-AC-8 | Host validation (DNS-rebinding defense) | ✅ | `security.ts:20-21, 33-35` | |
| is-AC-9 | one-time token, 401, constant-time, single-session | ✅ | `token.ts:18-27, 40-67`; `security.ts:60-72` (query-token restricted to SSE route — the security fix) | Regression test present for the fixed High. |
| is-AC-10 | token invalidated at completion; detect stays token-free | ✅ | `token.ts:62-67`; `routes.ts:220-226`; `security.ts:83-90` | |
| is-AC-11 | SSE progress, relay discipline, closed stage set | ✅ | `routes.ts:155-206` | |
| is-AC-12 | no fabricated percentage; stages from observable signals | ✅ | `install-state.ts:126-179` (resolving/downloading/linking/registering_service derived from real spawn milestones) | |
| is-AC-13 | per-product registration verb; failure marks install failed | ✅ | `install-state.ts:150-172`, `products.ts:39-43` | |
| is-AC-14 | install survives disconnect; re-subscribe gets current stage | ✅ | `routes.ts:187-194`; `install-state.ts:201-220` | |
| is-AC-15 | already-installed at pinned version → short-circuit | ✅ | `routes.ts:137-142` | |
| is-AC-16 | concurrent duplicate requests → one child process | ✅ | `install-state.ts:187-199` (`state.status === "in_progress"` synchronous guard) | |
| is-AC-17 | failure carries stage + truthful bounded error; retry permitted | ✅ | `install-state.ts:69-74, 117-124`; `spawn.ts:18-19, 56-60` (2 KB bound) | |
| is-AC-18 | health check reuses `fetchFleetStatus`/`isFleetReady` | ✅ | `routes.ts:34-37, 209-218` | |
| is-AC-19 | login via existing proxied `/setup/login` + `/setup/state` | ✅ | `login-step.tsx:18, 64-125` (imports `wire.ts`'s existing client, no new protocol) | |

### PRD-009b: onboarding route and guided flow

| # | Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| ob-AC-1 | `/onboarding` renders pre-health/pre-auth (gate-exempt) | ✅ | `gate.ts:52-55`; `boot-route.ts` (`ONBOARDING_PATH`) | `tests/dashboard/boot-route.test.ts` |
| ob-AC-2 | UI reflects daemon detection, never assumes client-side | ✅ | `onboarding-screen.tsx:147-165`; `contracts.ts:60-78` (per-product optional schema, safe default) | |
| ob-AC-3 | fully-installed healthy machine short-circuits | ✅ | `contracts.ts:80-83`; `onboarding-screen.tsx:154-155` | `tests/dashboard/onboarding/onboarding-screen.test.tsx` |
| ob-AC-4 | hero: animated brand-SVG entrance, staggered, Hive-mark anchored | ✅ | `onboarding-hero.tsx:60-146` | |
| ob-AC-5 | exactly two buttons, verbatim copy | ✅ | `onboarding-hero.tsx:116-123` | |
| ob-AC-6 | Standard installs remaining products, fixed order, no questions | ✅ | `onboarding-screen.tsx:167-177`; `contracts.ts:26, 89-91` | |
| ob-AC-7 | Advanced: card-checkbox picker → same guided flow for exactly the chosen products | ⚠️ | `advanced-picker.tsx` | First pass correct (confirmed with exactly the checked set); the resume path does not preserve the subset — see Warning above. |
| ob-AC-8 | full-screen card: logo, title, benefit copy | ✅ | `install-card.tsx:187-230` | |
| ob-AC-9 | staged progress, never a percentage bar | ✅ | `install-card.tsx:39-82` (`StageStepper`) | |
| ob-AC-10 | npm-safety copy, checkably true | ✅ | `product-copy.ts:61-62`; `install-card.tsx:85-104` | |
| ob-AC-11 | ~30s minimum dwell; failure surfaces early | ✅ | `use-install-dwell.ts`; `install-card.tsx:180-182` (never sees `ready:true` for a failed card) | |
| ob-AC-12 | failure shows truthful error + retry, never fake success | ✅ | `install-card.tsx:118-178, 232-259` | |
| ob-AC-13 | green-light per-daemon health view; advances only when ready | ✅ | `health-view.tsx` | |
| ob-AC-14 | device-code (`user_code`) + verification link displayed | ✅ | `login-step.tsx:34-62` (`LoginGrant`) | |
| ob-AC-15 | login completion → hard navigation to `/` | ✅ | `login-step.tsx:112-125` | |
| ob-AC-16 | re-entry reconstructs true state; resumes from first incomplete step | ⚠️ | `contracts.ts:93-107`; `onboarding-screen.tsx:147-165` | Resumes correctly for a Standard install; the Advanced-subset gap above applies here too. |
| ob-AC-17 | mid-install refresh re-attaches, no duplicate install | ✅ | `install-card.tsx:130-154` (`reattachOnly`) | |

### PRD-009c: onboarding telemetry

| # | Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| tm-AC-1 | full funnel event list at correct transitions | ✅ | `funnel-telemetry.ts:142-187`; `routes.ts` call sites | All nine events (`onboarding_started`, `mode_selected`, `product_install_{started,completed,failed}`, `health_check_passed`, `login_shown`, `login_completed`, `dashboard_reached`) confirmed in `emit.ts:177-186`. |
| tm-AC-2 | retry may re-emit product pair; session milestones once each | ✅ | `funnel-telemetry.ts:55-60, 117-140` (`SESSION_ONCE_SET` excludes product events) | |
| tm-AC-3 | single daemon-side chokepoint | ✅ | `emit.ts:398-446` (`emitTelemetry`) | |
| tm-AC-4 | closed property allow-list; anonymous distinct_id | ✅ | `emit.ts:119-163` (`ALLOWED_PROPERTY_KEYS` + `FUNNEL_PROPERTY_KEYS`) | |
| tm-AC-5 | token never in any event/property/log | ✅ | Confirmed by code inspection: `funnel-telemetry.ts` reads the token only to derive a session key hash (`onboarding-session-ledger.ts:38-40`, SHA-256), never passes the raw token to `emit`. | |
| tm-AC-6 | human vs headless distinguishable, shared install id | ✅ | `emit.ts:96-102` (`HONEYCOMB_HOME_DIR/install-id`); `install.sh:143` (`${HOME}/.honeycomb/install-id`) — same path | |

### PRD-009d: thin bootstrap companion

| # | Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| MV-1 | install surface moves honeycomb → the-apiary; deploy workflow builds from superproject source | ✅ | `the-apiary/site/install/`, `scripts/install/`; `.github/workflows/deploy-install-site.yaml`; honeycomb `git rm` of both trees | `node site/install/build.mjs` run and verified (dist/ emitted, `hive-release.json` copied). |
| MV-2 | manifest served via install site; scripts + hive default to `get.theapiary.sh` with GitHub fallback | ✅ (code); operational caveat | `scripts/install/install.sh:129-130`; `hive/src/daemon/installer/config.ts:19-26` | Both default to `get.theapiary.sh` with the GitHub raw URL as fallback. Live dry-run in this sandbox (no route to `get.theapiary.sh`) reproduced the exact "manifest unresolved" fallback path the ledger flags as closing "in production at the first tag deploy" — this is an environment/deploy-timing dependency, not a code defect. |
| bs-AC-1 | human path: Node, hive-only pinned install, daemon start, browser open, fallback line | ✅ | `install.sh:1088-1183` (`run_portal_path`) | Live dry-run confirms zero-prompt path and exact fallback line. |
| bs-AC-2 | no stdin read / prompt on the piped human path | ✅ | No `read` call anywhere in `run_portal_path` or its callees | |
| bs-AC-3 | exact fallback line, clean URL | ✅ | `install.sh:1141, 1181`; `install.ps1:975, 1021` | Verified verbatim in dry-run output. |
| bs-AC-4 | browser-open failure still prints line + exit 0 | ✅ | `install.sh:1075-1086` (`open_onboarding_url`, best-effort, never blocks `finish 0`) | |
| bs-AC-5 | token minted, `~/.honeycomb/hive/` file mode 0600, embedded in URL | ✅ | `install.sh:1055-1073` (`umask 077` + `chmod 600`) | |
| bs-AC-6 | token never echoed/logged/telemetered | ✅ | Confirmed: `phone_home` never receives the token; only `open_onboarding_url` embeds it in the browser-opened URL, never printed to stdout. | |
| bs-AC-7 | flag/env/config selection path preserved byte-for-byte | ✅ | `install.sh:1321-1336` (`main`), `selection_expressed` | Live dry-run with `--products=honeycomb,hive` confirmed the legacy path runs unchanged, including the documented `@latest` fallback when the manifest is unresolved (the accepted deferred Medium). |
| bs-AC-8 | `install.ps1` mirrors the human-path contract | ✅ | `install.ps1` (portal path present, same fallback line, same token file semantics) | Parsed cleanly with a real PowerShell interpreter in this environment (`[System.Management.Automation.Language.Parser]::ParseFile`), stronger evidence than the ledger's "pwsh unavailable" note. |

### PRD-001 close-out items (this run)

| # | Requirement (abridged) | Status | Implementation Location | Notes |
|---|---|---|---|---|
| P1-W1 | per-daemon connectivity gate (not honeycomb-global) | ✅ | `hive/src/dashboard/web/route-daemon-owner.ts`; `app.tsx:118-119, 145-153` (`daemonUpByOwner`) | `tests/dashboard/shell-connectivity-gate.test.tsx` proves isolation in both directions (nectar-down doesn't blank honeycomb pages and vice versa). |
| P1-S1 | stale honeycomb `CONVENTIONS.md` seam reference | ✅ | `honeycomb/src/daemon/runtime/dashboard/CONVENTIONS.md:43-49` | `mountDashboardHost` section replaced with a pointer to hive. |
| P1-S2 | two-daemon isolation test | ✅ | `tests/wire/fail-soft.test.ts:72-115`; `tests/dashboard/shell-connectivity-gate.test.tsx` | Both the data layer (`wire.ts`) and the UI shell layer are covered. |

### PRD-002 verification-map spot-check (independent re-derivation, sample of 10 + full disposition reconciliation)

The ac-verification-map claims 19 VERIFIED / 16 SUPERSEDED / 0 GAP across the module index, fs-AC-1..10, rs-AC-1..9, and ac-AC-1..8. I independently re-derived the following sample rather than trusting the map's citations at face value:

| # | Requirement (abridged) | Map disposition | My finding | Notes |
|---|---|---|---|---|
| fs-AC-6 | `isFleetReady()` true only when reachable + ok + all required peers ok | VERIFIED | ✅ Confirmed | `src/shared/fleet-readiness.ts:21-27` reads exactly as cited; logic matches fs-AC-6 verbatim. |
| fs-AC-7 | `degraded` aggregate never treated as ready | VERIFIED | ✅ Confirmed | Same file, line 23; `tests/shared/fleet-readiness.test.ts` "ac-AC-7" (read directly, passes). |
| fs-AC-8 | missing required peer → not ready | VERIFIED | ✅ Confirmed | Same file, lines 24-26; `tests/shared/fleet-readiness.test.ts` "ac-AC-8" (read directly, passes). |
| fs-AC-9 | tamper-safe, `isLoopbackBaseUrl()` guard | VERIFIED | ✅ Confirmed by pattern | `DOCTOR_STATUS_URL` is a hard-coded loopback constant (`src/shared/constants.ts:10`); the loopback-guard pattern this cites is the same one PRD-001c's security fix established and this run's own `is-AC-*` code reuses identically. |
| rs-AC-1..3, rs-AC-5, rs-AC-7, rs-AC-8, rs-AC-9 | `ReadinessSplash` retired; equivalent gate + `/buzzing` + `LoginScreen` mechanism | SUPERSEDED | ✅ Confirmed | `gate.ts:145-160` (this run's own file, read in full above) implements exactly the health-then-auth precedence the map cites, redirecting to `/buzzing`/`/login` as fixed literals; the cited tests (`tests/daemon/gate.test.ts`, `tests/dashboard/buzzing-screen.test.tsx`) are real files that exist in this tree. |
| rs-AC-4 | poll interval 1000-2000ms | VERIFIED | ✅ Confirmed | This run's own new test, read in full above (`tests/dashboard/buzzing-screen.test.tsx`, the fake-timer test added this run), genuinely exercises the 1000-2000ms window rather than asserting a constant. |
| rs-AC-6 | `supervisor: unreachable` shows a distinct waiting-on-doctor state | SUPERSEDED (equiv: `AwaitingRegistrationIndicator`) | ✅ Confirmed | This run's own new test (`buzzing-screen.test.tsx`, read in full above) asserts the `buzzing-empty` testid text matches `/waiting on doctor/i`. |
| ac-AC-6 | `/api/fleet-status` rejects non-loopback URLs | VERIFIED | ✅ Confirmed | Same as fs-AC-9; the constant is hard-coded, not request-derived, so no tamper surface exists to test beyond the constant's own definition. |
| ac-AC-7 | degraded aggregate blocks setup even if named peers are ok | VERIFIED | ✅ Confirmed | `tests/shared/fleet-readiness.test.ts` (this run's own new file, read in full above) directly exercises this exact case and passes. |
| ac-AC-8 | honeycomb missing from `daemons[]` despite aggregate ok | VERIFIED | ✅ Confirmed | Same file, same read; direct case coverage confirmed. |

No discrepancies found in the sampled rows; the map's citations for both VERIFIED and SUPERSEDED dispositions point to real files and real behavior, not aspirational or stale references. The full 19/16/0 breakdown is accepted based on this sample plus the fact that the full suite (347/347, including every fs/rs/ac test file the map cites) passes.

### Non-Goals honored (spot-checked)

| Non-Goal | Source | Status | Notes |
|---|---|---|---|
| No product uninstall UI | PRD-009 index | ✅ Honored | No uninstall endpoint or UI affordance found in `src/daemon/installer/` or `onboarding/`. |
| No license/entitlement backend | PRD-009 index | ✅ Honored | Not touched by this diff. |
| No changes to CI/headless flag installs | PRD-009 index, bs-AC-7 | ✅ Honored | Confirmed by dry-run: `--products=` routes to `legacy_main` unchanged. |
| No remote/non-loopback install | PRD-009 index, PRD-009a | ✅ Honored | `security.ts` Host/Origin allowlists are hard-coded to `127.0.0.1:3853`/`localhost:3853`; daemon bind unchanged. |
| No new device-flow protocol | PRD-009 index, PRD-009b | ✅ Honored | `login-step.tsx` imports `wire.ts`'s existing `setupLogin`/`setupState`, no new endpoint. |
| No replacement of doctor's watchdog role | PRD-009 index | ✅ Honored | `install-state.ts` only spawns each product's own registration verb, never writes another product's registry entry. |
| No visual-design specification (PRD-002) | PRD-002 index | ✅ Honored | Splash/buzzing visual treatment is implementation-owned, not re-litigated here. |
| No `degraded`-allows-setup exception (PRD-002) | PRD-002 index | ✅ Honored | `fleet-readiness.ts:23` blocks on any non-`ok` aggregate health, no exception. |

## Verification Commands Run

| Command | Location | Result |
|---|---|---|
| `npm run typecheck` | `hive` | Clean (0 errors) |
| `npm test` | `hive` | **347/347 passed**, 51 files |
| `npm run typecheck` | `honeycomb` | Clean (0 errors), run twice (before and after reviewing the removal diff) |
| `npm test` | `honeycomb` | **4037/4049 passed** (12 skipped), 370 files, 0 failed |
| `bash -n scripts/install/install.sh` | the-apiary root | Syntax OK |
| PowerShell `Parser::ParseFile` on `scripts/install/install.ps1` | the-apiary root | Parse OK (real PowerShell interpreter available in this environment, stronger than the ledger's untested claim) |
| `node site/install/build.mjs` | the-apiary root | Success — `dist/install.sh`, `dist/install.ps1`, `SHA256SUMS`, `hive-release.json` (manifestVersion 0.2.1), `blessed-version.json`, `_headers`, `favicon.svg`, `index.html` all emitted |
| `sh scripts/install/install.sh --dry-run` | the-apiary root | Portal path exercised: correct zero-flag routing, exact fallback line, manifest-unresolved-in-sandbox correctly refused rather than falling back to `@latest` (portal path fails closed per is-AC-5/bs-AC-1) |
| `sh scripts/install/install.sh --products=honeycomb,hive --dry-run` | the-apiary root | Legacy path exercised: correct flag routing, and the accepted deferred Medium (`@latest` fallback on unresolved manifest) reproduced exactly as the security close-out describes |

## Files Changed

**`hive`** (feature/prd-009-onboarding-installer):

- `README.md` (M), status line updated to "production ready" alongside the harness-count badge change.
- `assets/brand/doctor-mark.svg`, `assets/brand/nectar-mark.svg` (A), new product marks for the hero/cards.
- `library/knowledge/private/architecture/landing-gate-and-routing.md`, `system-overview.md`, `library/knowledge/private/frontend/buzzing-and-health-rail.md`, `library/knowledge/private/infrastructure/release-train-and-manifest.md` (M), status-currency edits; the last carries the stale publish-status Warning above.
- `library/requirements/backlog/prd-009-onboarding-installer/*` → `library/requirements/in-work/prd-009-onboarding-installer/*` (R), the PRD moved from backlog to in-work per the ledger's baseline step.
- `library/requirements/in-work/prd-002-portal-readiness-splash/qa/ac-verification-map-2026-07-03.md` (A), the PRD-002 verification map, spot-checked above.
- `src/daemon/dashboard/host.ts`, `web-assets.ts` (M), the `/assets/brand/:name` route with a leaf-`*.svg`-only allowlist regex (no path traversal).
- `src/daemon/gate.ts` (M), `/onboarding` added to `GATE_EXEMPT_ROUTES`.
- `src/daemon/installer/` (A, 13 files), the full installer service: `bin-resolver.ts`, `config.ts`, `detection.ts`, `funnel-telemetry.ts`, `index.ts`, `install-state.ts`, `manifest.ts`, `manifest-snapshot.json`, `products.ts`, `routes.ts`, `security.ts`, `spawn.ts`, `token.ts`.
- `src/daemon/server.ts` (M), installer service registered before the generic `/api/*` proxy.
- `src/dashboard/web/app.tsx` (M), per-owner connectivity gate (P1-W1 fix).
- `src/dashboard/web/boot-route.ts`, `main.tsx` (M), `/onboarding` boot-screen wiring.
- `src/dashboard/web/onboarding/` (A, 11 files), the guided-flow UI: `advanced-picker.tsx`, `contracts.ts`, `health-view.tsx`, `install-card.tsx`, `login-step.tsx`, `onboarding-client.ts`, `onboarding-hero.tsx`, `onboarding-screen.tsx`, `product-copy.ts`, `use-install-dwell.ts`, `use-onboarding-token.ts`.
- `src/dashboard/web/route-daemon-owner.ts` (A), the per-owner route resolver (P1-W1 fix).
- `src/shared/onboarding-types.ts` (A), the daemon-side canonical wire contract.
- `src/telemetry/emit.ts` (M), funnel event types + `FUNNEL_PROPERTY_KEYS` allow-list extension.
- `src/telemetry/onboarding-session-ledger.ts` (A), the session-scoped once-per-event dedupe ledger.
- `tests/daemon/installer/` (A, 10 files), `tests/dashboard/onboarding/` (A, 6 files), `tests/dashboard/route-daemon-owner.test.ts`, `tests/dashboard/shell-connectivity-gate.test.tsx`, `tests/shared/fleet-readiness.test.ts` (A), `tests/dashboard/boot-route.test.ts`, `tests/dashboard/buzzing-screen.test.tsx`, `tests/dashboard/copy-map.test.ts`, `tests/wire/fail-soft.test.ts` (M).

**the-apiary** (feature/install-surface-and-fleet-onboarding):

- `.github/workflows/deploy-install-site.yaml` (M), builds from local superproject source instead of a honeycomb checkout.
- `README.md` (M), fleet status table updated (harness counts, production-ready flips across honeycomb/doctor/hive/nectar).
- `library/knowledge/private/architecture/ADR-0001-*.md`, `ADR-0002-*.md` (M), status notes appended (non-destructive, Context sections left as historical record).
- `library/ledger/EXECUTION_LEDGER-onboarding-installer.md` (A), the orchestration ledger this report verifies independently.
- `scripts/install/` (A), `site/install/` (A), the moved install surface (mirrors honeycomb's prior trees plus the MV-2 manifest-serving and get.theapiary.sh-default changes).

**honeycomb** (feature/move-install-surface-to-apiary):

- `.gitignore` (M), removed the now-obsolete `/site/install/dist/` ignore rule.
- `README.md`, `library/knowledge/private/operations/fleet-and-usage-telemetry.md`, `install-and-onboarding.md`, `overview.md`, `library/knowledge/public/overview/what-is-honeycomb.md` (M), cross-repo link updates plus the out-of-scope "production ready" prose noted as a Suggestion above.
- `scripts/install/install.sh`, `install.ps1`, `scripts/install/tests/fixtures/manifest-{malicious,mixed}.json`, `scripts/install/tests/install.test.sh`, `site/install/{README.md,_headers,build.mjs,functions/index.js,index.template.html}` (D), the moved trees, cleanly removed.
- `src/daemon/runtime/dashboard/CONVENTIONS.md` (M), the stale `mountDashboardHost` reference replaced (P1-S1 fix).
- `src/daemon/runtime/telemetry/version-check.ts` (M), comment updated to point at the-apiary's install scripts.
