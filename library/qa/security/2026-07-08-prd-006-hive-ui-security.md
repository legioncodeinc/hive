# Security Audit: PRD-006 hive-UI harness-connect track

- **Date:** 2026-07-08
- **Auditor:** security-worker-bee
- **Branch:** `feature/prd-006-hive-ui`
- **Audited commit (pre-fix):** `500116d`
- **Scope:** ONLY the diff introduced by `500116d` (the three honeycomb harness-connect routes, their CLI client, server wiring, and the React UI that calls them). Pre-existing hive code outside these files was not in scope.
- **Stack note:** Hive is a React + Hono + zod loopback dashboard daemon (127.0.0.1:3853) that shells the honeycomb CLI. This is adjacent to, not identical to, the Hivemind stack the security-stinger was forged against. Coverage of this diff is full fidelity for the injection / route-exposure / resource / info-leak / validation threat model requested; no reduced-coverage flag is needed for the audited surface.

## Executive summary

One **High** finding: argument (flag) injection into the honeycomb spawn via the unvalidated `harness`
repair parameter. Remediated in place. The spawn was already `shell:false` with a fixed argv, so no
shell-command injection was ever possible, but the request-derived `harness` value flowed into the
argv with no allowlist and no leading-dash guard, so a value such as `--config=...` or `-h` would be
handed to honeycomb's argument parser as a flag. Fixed at two layers (the HTTP boundary and the argv
sink) with canonical-harness-id validation, plus a zod-shaped boundary rejection. Typecheck stays
green and the harness suites pass (30/30, including the new negative tests). Aikido SAST scanned the
changed files with 301 rules and returned 0 findings.

The tokenless-route design (finding #2 below) is ruled **ACCEPT AS-IS**, conditional on the arg
injection fix which has now landed.

## Findings by severity

### High

#### H-1 - Argument (flag) injection via the `harness` repair parameter

- **Location (pre-fix):** `src/daemon/harness/routes.ts:63-67` (`readRepairHarness`) -> `src/daemon/harness/honeycomb-cli.ts:194-197` (`repair` argv build) -> `src/daemon/installer/spawn.ts:87` (spawn).
- **Vulnerable pattern:** `readRepairHarness` accepted any non-empty string and passed it straight into `["repair", harness]`, which became argv element `[cliJs, "harness", "repair", <harness>, "--json"]`. There was no allowlist and no leading-`-`/`--` rejection.
- **Impact:** `shell:false` + argv array blocks shell metacharacter / command injection (confirmed correct in `spawn.ts`). It does NOT block argument injection: a `harness` value beginning with `-`/`--` (for example `--config=/some/path`, `-h`, or a duplicate `--json`) is interpreted by honeycomb's own CLI arg parser as a flag rather than a positional harness id. Depending on honeycomb's flag surface, this is at minimum unexpected-behavior injection and at most a lever to alter honeycomb's reconcile behavior through a hive daemon endpoint. The threat model explicitly required allowlist-or-dash-safe validation here.
- **Severity rationale:** High, not Critical: no shell/RCE (shell:false holds), no secret exposure, and reachability is gated by the Host + Origin guard (see #2), so a browser cross-origin drive-by cannot reach it. It is High rather than Medium because it is a request-influenced value reaching a process-spawn argv with zero validation, which is the exact class the diff was asked to close.
- **Remediation (applied):** Added a canonical harness-id shape `HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/` and `isValidHarnessId()` in `honeycomb-cli.ts`. The anchor `[a-z0-9]` at the head rejects every leading-dash value (kills flag injection); the body class rejects `=`, whitespace, path separators, and quotes. A slug-shape allowlist was chosen over a hardcoded id enum because honeycomb owns the canonical harness list and duplicating it in hive would drift; the shape is the "otherwise incapable of argv smuggling" path the threat model allows.
  - Defense layer 1 (HTTP boundary, `routes.ts`): `readRepairHarness` now returns a discriminated result. An absent/empty `harness` targets the default (unchanged behavior). A present `harness` that is a non-string or a non-canonical id causes the route to return `400 { error: "invalid harness" }` and never calls the CLI. This is the zod-shaped boundary rejection requested in threat item #5.
  - Defense layer 2 (argv sink, `honeycomb-cli.ts`): `repair()` re-validates the target and, if invalid, degrades fail-soft to `{ harness: DEFAULT_HARNESS, status: "error", connected: false }` WITHOUT ever spawning. This protects every caller of the CLI client, not just the HTTP route, and does not echo the rejected input back.
- **Tests added:** `tests/daemon/harness/routes.test.ts` (flag-shaped and non-string `harness` return 400 and never shell) and `tests/daemon/harness/honeycomb-cli.test.ts` (a flag-shaped harness never reaches the spawn argv; `spawn.calls` stays empty).

### Medium

None detected in the audited diff. (See L-1 for a documented low-severity hardening note on spawn concurrency.)

### Low

#### L-1 - No concurrency cap on the spawn-triggering routes (documented, not fixed)

- **Location:** `src/daemon/harness/routes.ts:89-109` - each `connect` / `repair` POST and each `status` GET independently spawns a honeycomb process.
- **Observation:** Per-call lifetime IS bounded: `HONEYCOMB_CLI_TIMEOUT_MS = 15000` drives an `AbortController` that aborts the spawn (`honeycomb-cli.ts:141-142,151`). There is, however, no cap on the number of concurrently in-flight spawns, so repeated POSTs create one process each.
- **Why Low, not fixed in-session:** Reachability is gated by the Host + Origin guard, so no cross-origin page can drive it, and a local process that could hit the loopback endpoint can already spawn processes directly (the daemon grants no new capability). Each process is time-bounded, and browsers cap concurrent same-origin connections. A proper fix (an in-flight semaphore + tests) exceeds the minimal-blast-radius bar for a low-exploitability, gated issue.
- **Recommended follow-up (not blocking):** add a small in-flight guard / single-flight for `connect` and `repair` if this surface is ever exposed beyond loopback.

## Threat-model checklist (as requested)

1. **Command / argument injection via the spawn** - `shell:false` confirmed (`spawn.ts:87`), argv is a fixed array, no shell string is expressible. The user-influenced `harness` repair value was the one gap: it is now allowlist/dash-safe validated at both the route boundary and the argv sink (finding H-1). Bin-path resolution cannot be hijacked by the request: the spawned command is always the absolute `process.execPath` (node), the entry is the absolute `*.js` resolved from the global npm prefix's `@legioncodeinc/honeycomb` `package.json#bin` (`bin-resolver.ts`), and `childEnv` prepends only `dirname(execPath)` to PATH. No request data reaches prefix/package resolution, so there is no PATH/prefix injection from these routes. **Closed.**
2. **Route exposure / SSRF / DNS-rebinding / cross-origin drive-by (the tokenless-route question)** - **RULING: ACCEPT AS-IS**, conditional on H-1 (now fixed). Rationale:
   - DNS-rebinding is closed by the Host allowlist (`installer/security.ts:21` - only `127.0.0.1:3853` / `localhost:3853`). A rebound hostname resolving to loopback still fails the `Host` check.
   - Cross-origin drive-by / CSRF is closed by the Origin allowlist (`security.ts:24,48-51`): browsers set `Origin` on all POSTs and page JavaScript cannot forge it; a missing `Origin` on a non-GET is rejected. No foreign page can drive `connect`/`repair`.
   - The operations return only ids / booleans / status strings (no secret, no token, no path), are idempotent and self-healing, and start no session, so even a hypothetical triggered call exfiltrates nothing and makes no destructive change.
   - This matches the installer's own Host + Origin model. The installer additionally requires a one-time token, but that gates a materially more dangerous surface (arbitrary `npm install` package input + a session lifecycle). Harness connect/repair has neither once the argv param is validated, so Host + Origin is a proportionate CSRF/rebinding defense here. Adding a token would be defense-in-depth, not a correctness requirement.
   - Condition: this ruling holds because H-1 is fixed. A tokenless, spawn-triggering endpoint with an unvalidated argv parameter would have been a materially larger surface; with the parameter validated, accept-as-is is sound.
3. **Resource exhaustion** - Per-call timeout is bounded (15s AbortController). No unbounded-lifetime spawn. No concurrency cap exists; rated Low and documented (L-1) rather than fixed, given the Host+Origin gating and time-bounding.
4. **Info leak** - Responses return only `{ harness, status, connected?, detail? }` / `{ harnesses: [...] }`, all zod-validated to ids/booleans/status strings. `stderrTail` is never returned (only `stdoutTail` is parsed). All fail-soft paths map to generic status strings; error bodies are `{ error: "forbidden" }` (403), `{ error: "unauthorized" }` (401), and the new `{ error: "invalid harness" }` (400) - no stack traces, no absolute paths, no tokens. The optional `detail` field is a passthrough of honeycomb's own already-redacted contract string; hive relies on honeycomb's redaction there (noted as an upstream assumption, not a hive-diff defect). **None detected** in this diff.
5. **Zod boundary validation on the repair body** - The repair body is now validated: a present `harness` must be a canonical harness id or the route returns 400 (rejecting unexpected shapes, including non-string values). Extra fields are ignored by design (unchanged). **Closed.**

## Remediation summary

| ID | Severity | Status | Files |
|----|----------|--------|-------|
| H-1 | High | Fixed | `src/daemon/harness/honeycomb-cli.ts`, `src/daemon/harness/routes.ts`, `src/daemon/harness/index.ts` (+ tests) |
| L-1 | Low | Documented (follow-up recommended) | `src/daemon/harness/routes.ts` |

- **Aikido SAST:** 301 rules across the changed files, 0 findings. (Checkov/IaC sub-scan errored only because the tool binary is not installed locally; not a finding.)
- **Typecheck:** `npm run typecheck` clean after the fix.
- **Tests:** `vitest run` over the harness + harness-UI suites: 30 passed / 30, including the new negative-path tests.
- **Commit:** see the `fix(security):` commit on `feature/prd-006-hive-ui` (sha recorded in the chat close-out). Not pushed.
