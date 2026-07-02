# Security Audit Report: PRD-002 Portal Readiness Splash

**Audit date:** 2026-07-01
**Auditor:** security-worker-bee subagent
**Branch:** `feature/prd-002-portal-readiness-splash` (worktree `the-apiary-hive-002`), based on `feature/prd-001-hive-portal-daemon`.
**Scope (the PRD-002 diff):**
- `src/shared/fleet-readiness.ts` (NEW, browser-safe pure module)
- `src/daemon/fleet-status.ts` (NEW, server proxy `fetchFleetStatus`)
- `src/daemon/server.ts` (MODIFIED, `GET /api/fleet-status` route + injectable seams)
- `src/shared/constants.ts` (MODIFIED, `DOCTOR_STATUS_URL`)
- `src/dashboard/web/readiness-splash.tsx` (NEW, `ReadinessSplash`)
- `src/dashboard/web/main.tsx` (MODIFIED, top-level render wraps `SetupGate`)
- `src/dashboard/web/fleet-readiness.ts` (DELETED, deduped into shared)
- `tests/daemon/fleet-status.test.ts`, `tests/dashboard/readiness-splash.test.ts`, `tests/dashboard/copy-map.test.ts`

**Stack note (reduced-fidelity flag):** hive is a TS/Node + Hono portal daemon + React dashboard. It has NO Deep Lake, NO MCP server, NO pre-tool-use VFS gate, and NO captured traces. The Stinger's Hivemind-specific catalogs (Deep Lake SQL injection, the pre-tool-use gate, captured-trace PII, mined-skill prompt injection) DO NOT APPLY here and were not audited. The audit was adapted to hive's actual PRD-002 attack surface below.

**Ordering check:** the PRD-002 `qa/` folder contained only `.gitkeep`; no `*-qa-report.md` / `*-quality-report.md` predates this audit. `quality-worker-bee` has not run for this branch. Ordering is correct: security runs first.

**Diff note:** all PRD-002 work is uncommitted in the worktree (HEAD equals the base commit `50b216f`), so `git diff base...HEAD` is empty. The working tree was audited directly. My two remediation edits are to new/untracked files (`src/daemon/fleet-status.ts`, `tests/daemon/fleet-status.test.ts`), so they do not appear in the tracked-file `git diff`; the tracked diff shows only the pre-existing PRD-002 changes.

---

## Executive Summary

One **Medium** finding, remediated in-session: the doctor status fetch used native `fetch` with its default `redirect: "follow"`, so the `isLoopbackBaseUrl()` pin (fs-AC-9) validated only the initial URL. A rogue or compromised loopback service answering on `127.0.0.1:3852` could 3xx-redirect the fetch to a non-loopback origin, silently defeating the loopback pin (SSRF-adjacent, the same threat class PRD-001 hardened against a tampered registry). Fixed by pinning `redirect: "error"` on the fetch so any redirect rejects before the off-loopback request fires; covered by two new tests.

Everything else on the PRD-002 attack surface was reviewed and found clean: the status URL is a hard-pinned loopback constant not derivable from any request/registry/env input; the client-facing response body is limited to the normalized `{ supervisor, health, daemons, asOf }` shape with the fail-soft path leaking nothing about why doctor was unreachable; the doctor body is zod-validated at the boundary with `escalation` held as opaque `unknown`; `ReadinessSplash` genuinely does not mount `SetupGate` (and therefore never calls `/setup/state`) until `isFleetReady()` passes; the built browser bundle contains no Node imports; the route returns JSON only with no request-driven redirect; and the PRD-001 loopback / federated-`wire` posture is unchanged. No Critical or High findings.

**Final gate (after remediation):** `npm run typecheck` clean, `npm test` = 14 files / 66 tests pass (was 64; +2 new redirect-pinning tests), `npm run build` clean. Browser bundle `dist/daemon/dashboard/app.js` verified free of `node:*` / `require(` references.

---

## Scorecard

| # | Attack surface (PRD-002) | Status | Findings |
|---|---|---|---|
| 1 | SSRF / loopback pinning of doctor fetch (fs-AC-2, fs-AC-9) | ATTN -> FIXED | 1 (Medium, remediated) |
| 2 | Upstream error / info leakage in `/api/fleet-status` body (fs-AC-10) | OK | 0 |
| 3 | zod at the external boundary; `escalation` opaque (fs-AC-4) | OK | 0 |
| 4 | Splash must not leak setup state while blocked (rs-AC-3) | OK | 0 |
| 5 | Browser bundle purity (no Node imports) | OK | 0 |
| 6 | No open redirect / route injection | OK | 0 |
| 7 | PRD-001 posture unchanged (loopback fix, `wire` trust model) | OK | 0 |

Legend: **OK** = zero findings - **ATTN -> FIXED** = finding found and remediated this session.

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings (remediated in this session)

- [x] **SSRF defense-in-depth gap - doctor status fetch follows redirects off loopback** `src/daemon/fleet-status.ts:37-46` (pre-fix). `fetchFleetStatus` guarded the target with `isLoopbackBaseUrl(url)` and then called `fetchImpl(url)` with no `redirect` option, so native `fetch` used its default `redirect: "follow"`. The loopback pin only validates the *initial* URL; a 3xx response from whatever process is listening on `127.0.0.1:3852` (a rogue local process squatting the port, or a compromised doctor - the exact threat class PRD-001's registry loopback fix was written for) would be transparently followed to an arbitrary non-loopback origin, turning hive into an SSRF relay and defeating fs-AC-9's defense-in-depth guarantee. **Severity: Medium** - the initial URL is hard-pinned and not attacker-controllable via any request/registry/env input (verified), so exploitation requires an attacker to already control a loopback listener; it is a defense-in-depth hardening of a documented trust boundary, not a directly remotely-triggerable bug. **Fix (`src/daemon/fleet-status.ts`):** introduced `FleetFetchInit` (`{ redirect?: "error" | "follow" | "manual" }`), widened `FetchImpl` to `(input: string, init?: FleetFetchInit) => Promise<Response>`, and changed the call to `fetchImpl(url, { redirect: "error" })`. With `redirect: "error"`, fetch rejects on any redirect, so the off-loopback request never fires and the existing `try/catch` fail-softs to `{ supervisor: "unreachable", daemons: [] }`. **Tests (`tests/daemon/fleet-status.test.ts`):** added `fs-AC-9 pins redirect mode so a loopback 3xx cannot follow off loopback` (asserts fetch is called with `{ redirect: "error" }`) and `fs-AC-9 fail-softs when the fetch rejects on a redirect`; updated the existing `fs-AC-1` route assertion to `toHaveBeenCalledWith(DOCTOR_STATUS_URL, { redirect: "error" })`.

---

## Low Findings (documentation only / accepted risk)

- [ ] **`escalation` is an opaque `unknown` pass-through to the client** `src/daemon/fleet-status.ts:66-70`, `src/shared/fleet-readiness.ts:7`. Per-daemon `escalation` is validated as `z.unknown().nullable().optional()` and passed straight through into the `/api/fleet-status` body. **Accepted risk / Low:** this is by design (fs-AC-3 / the type contract - hive must not interpret doctor's escalation internals) and the value originates from the trusted loopback doctor, delivered to the operator's own same-origin loopback dashboard. The dashboard (`readiness-splash.tsx`) reads only `daemon.name` and `daemon.health`, never `escalation`, so nothing sensitive is rendered. No hive-internal detail (headers, upstream URL, stack traces, error text) is echoed. No change required; noted so a future consumer that starts rendering `escalation` reconsiders it.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **Status URL is hard-pinned loopback, not derivable** (fs-AC-2) | Fetch target is the `DOCTOR_STATUS_URL` constant, never from registry / request / query / env | `src/shared/constants.ts:10` (`DOCTOR_STATUS_URL = "http://127.0.0.1:3852/status.json"`); `src/daemon/server.ts:79` (`options.doctorStatusUrl ?? DOCTOR_STATUS_URL` - injectable only at daemon construction, not per-request); `fetchFleetStatus` default `url = DOCTOR_STATUS_URL` | OK |
| **Loopback guard fires before the fetch** (fs-AC-9) | `isLoopbackBaseUrl()` gates the URL; a non-loopback URL is rejected and never fetched | `src/daemon/fleet-status.ts:47-49` (`if (!isLoopbackBaseUrl(url)) return UNREACHABLE_RESPONSE;` before any fetch); test `fs-AC-9 rejects non-loopback URL without fetching` asserts `fetchImpl` not called. Plus new redirect pin so a loopback 3xx cannot escape | OK (hardened) |
| **Response body limited to normalized shape** (fs-AC-10) | Only `{ supervisor, health, daemons:[{name,health,escalation}], asOf }`; no raw headers / upstream URL / stack / error text | `src/daemon/fleet-status.ts:63-72` builds only those fields; upstream `suggestedCommands` dropped; test `fs-AC-10 response body contains only normalized fields` asserts key set and that `"3852"` never appears | OK |
| **Fail-soft leaks nothing about WHY** | `{ supervisor: "unreachable", daemons: [] }` on any failure | `UNREACHABLE_RESPONSE` returned for: non-loopback URL, redirect/throw, non-200, JSON-parse error, zod failure (`fleet-status.ts:16-19, 47-75`); route returns HTTP 200 with that body (`server.ts:81-83`) | OK |
| **zod at the external boundary** (fs-AC-4) | doctor body `safeParse`d before trust; malformed body fail-softs, does not throw into the handler; `escalation` opaque | `DoctorStatusSchema` (`fleet-status.ts:29-33`) with `daemons` optional-defaulted; `safeParse` + `if (!parsed.success) return UNREACHABLE_RESPONSE` (`58-61`); `escalation: z.unknown().nullable().optional()` (`26`) | OK |
| **Splash does not mount SetupGate while blocked** (rs-AC-3) | `SetupGate` unmounted (its `/setup/state` poll cannot fire) until `isFleetReady()`; splash shows only fleet data | `readiness-splash.tsx:296-329`: renders `<FleetSplashGrid>` while `!fleetGated`, `<SetupGate>` only after `isFleetReady(next)` flips `fleetGated`; poll hits only `/api/fleet-status` (`305`); grid renders only daemon name + coarse display-state | OK |
| **Browser bundle purity** | `src/shared/fleet-readiness.ts` has no Node imports; built bundle has no `node:*` / `require(` | `fleet-readiness.ts` is pure types + functions (no imports); `dist/daemon/dashboard/app.js` grep: 0 `require("node:`, 0 `from"node:`, 0 `require(`; the only `node:` substrings are `{node:r}` graph-node object literals and `"net"`/`"path"` are UI label/color strings | OK |
| **No open redirect / route injection** | `/api/fleet-status` returns JSON only, no redirect on request input | `server.ts:81-83` uses `c.json(...)` exclusively; no `c.redirect`, no `Location` header set anywhere in the route | OK |
| **PRD-001 posture unchanged** | `daemon-bases` loopback fix and federated `wire` trust model not regressed | `src/shared/daemon-routing.ts` unchanged (still exports `isLoopbackBaseUrl` allow-listing `127.0.0.1`/`localhost`/`::1`/`[::1]`); `server.ts:76` `/api/daemon-bases` still via `resolveDaemonBases`; PRD-002 only adds the fleet-status route/constant | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/daemon/fleet-status.ts` | Added `FleetFetchInit`; widened `FetchImpl` to accept an `init`; call `fetchImpl(url, { redirect: "error" })` so a loopback 3xx cannot follow off loopback (fs-AC-9 defense in depth). |
| `tests/daemon/fleet-status.test.ts` | Added two `fs-AC-9` tests (redirect-mode pinned; fail-soft on redirect rejection); updated the `fs-AC-1` route assertion to expect the `{ redirect: "error" }` init. |

Minimal blast radius: only these two (new/untracked PRD-002) files were edited; no unrelated changes. No new runtime dependency added (zod was already present and is acceptable for hive).

---

## Gate Status (after remediation)

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (clean) |
| `npm test` | PASS - 14 files / 66 tests (baseline 64 + 2 new) |
| `npm run build` | PASS - `dist/daemon/dashboard/app.js` built; verified 0 Node imports |

---

## Recommended Follow-Up

- None blocking. `quality-worker-bee` may now run against a security-clean tree. If a future consumer starts rendering per-daemon `escalation`, re-evaluate that opaque pass-through (Low note above).
