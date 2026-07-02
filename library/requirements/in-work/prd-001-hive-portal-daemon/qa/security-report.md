# Security Audit Report: PRD-001 hive Portal Daemon

**Audit date:** 2026-07-01
**Auditor:** security-worker-bee subagent
**Scope:**
- `hive/src/**` (primary) — process bootstrap, single-instance lock, dashboard host + asset resolver, doctor registry reader, federated `wire` client, service install/uninstall, CLI.
- `honeycomb/src/**` (cutover delta only) — dashboard-retirement surface: `daemon/runtime/server.ts` route table, `daemon/runtime/assemble.ts` mount wiring, `commands/install.ts` browser-open flow.

**Focus areas (as scoped by the requester):** loopback binding, font/static path traversal, registry JSON write safety, federated wire fetch (SSRF if bases misconfigured), credential leakage in the portal shell, CLI service-install command injection.

**Ordering check:** No `*-qa-report.md` / `*-quality-report.md` exists yet under `hive/library/requirements/in-work/prd-001-hive-portal-daemon/qa/` (only `.gitkeep`). `quality-worker-bee` has not run for this branch — ordering is correct; this audit runs first.

**`hive` is an untracked greenfield tree** (no prior commit of `src/`), so there is no pre-existing git baseline to diff against; changes below are called out explicitly by file instead of via `git diff` review.

---

## Executive Summary

One **High** finding: the federated `wire` client trusted any absolute URL a doctor registry entry (or the `/api/daemon-bases` response) supplied as a daemon base, with no requirement that it resolve to loopback. Since every legitimate workload daemon binds `127.0.0.1` only, a tampered or malicious `~/.honeycomb/doctor.daemons.json` entry could redirect the dashboard's POST/GET traffic — including captured session/memory request bodies — to an attacker-controlled origin. Fixed in this session at both the server-side trust boundary (registry parsing) and the browser-side schema (defense in depth). All other scoped areas (loopback binding, font/static asset routes, registry JSON write safety, portal-shell credential handling, CLI service-install command construction) were reviewed and found clean. No Critical findings. Two Low/Medium hygiene notes are documented for follow-up but do not block ship.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Loopback binding (`HIVE_HOST`/`DAEMON_HOST`, `serve()` hostname) | OK | 0 |
| Font / static asset path traversal (`web-assets.ts`, `host.ts`) | OK | 0 |
| Registry JSON write safety (`install/registry.ts` upsert) | ATTN | 1 (Low) |
| Federated wire fetch / SSRF (`daemon/registry.ts`, `dashboard/web/wire.ts`) | FAIL → FIXED | 1 (High, remediated) |
| Credential leakage in portal shell (`daemon/dashboard/host.ts`, `dashboard/web/wire.ts`, `setup-gate.tsx`) | OK | 0 |
| CLI service-install command injection (`service/commands.ts`, `service/index.ts`, `service/templates.ts`) | OK | 0 |
| Honeycomb dashboard-retirement delta (`server.ts`, `assemble.ts`, `commands/install.ts`) | ATTN | 1 (Low, pre-existing, unrelated to retirement) |

Legend: **OK** = zero findings · **ATTN** = Medium/Low findings documented · **FAIL → FIXED** = High/Critical found and remediated in this session.

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **SSRF / trust-boundary violation — federated wire fetch accepts a non-loopback daemon base** `hive/src/daemon/registry.ts:30-42` and `hive/src/dashboard/web/wire.ts:1304-1307` — `baseUrlFromHealthUrl()` accepted any value that passed `z.string().url()` (including a public/attacker-controlled hostname) from `~/.honeycomb/doctor.daemons.json`, and the browser's `DaemonBasesSchema` re-trusted whatever `/api/daemon-bases` returned with the same lax check. Every legitimate daemon in this topology binds `127.0.0.1` only, so a tampered registry entry (or registration by a rogue local process) could redirect the dashboard's federated fetch — including POST bodies carrying captured session/memory content — to an external origin. **Fix:** added `isLoopbackBaseUrl()` to `hive/src/shared/daemon-routing.ts` (allow-lists `127.0.0.1` / `localhost` / `::1` / `[::1]`); `baseUrlFromHealthUrl()` now rejects (returns `null`, causing fail-soft fallback to the documented loopback default) any `healthUrl` whose origin is not loopback; `DaemonBasesSchema` in `wire.ts` adds the same `.refine(isLoopbackBaseUrl)` before its `.catch()` default, so the browser client never forwards state-changing/data-bearing requests to a non-loopback origin even if the server-side check were ever bypassed.

---

## Medium Findings (follow-up required)

None detected.

---

## Low Findings (documentation only)

- [ ] **Registry file written with default (world-readable) permissions** `hive/src/install/registry.ts:57-59` (`createNodeRegistryFs().writeFile` → `writeFileSync(path, content, "utf8")`) — `~/.honeycomb/doctor.daemons.json` is written with the process umask default (typically `0644`) rather than an explicit restrictive mode. The file's current contents (daemon name, healthUrl, pid path, restart tuning) are not secrets, so this is Low, not High — but if the registry's schema ever grows a sensitive field, an explicit `0600` mode should be set at write time. Documented for follow-up; not fixed in-session because it is a policy decision about the registry's future contents, not a live vulnerability today.
- [ ] **No CORS / explicit anti-CSRF header on hive's unauthenticated GET routes** `hive/src/daemon/server.ts` (`/health`, `/api/daemon-bases`) — Hono's default (no `Access-Control-Allow-Origin`) already prevents a cross-origin page from reading these responses via `fetch`, and both endpoints return only non-sensitive bootstrap metadata, so this is not currently exploitable. Flagged only so a future authenticated or state-changing route added to hive's unprotected group does not inherit this posture by copy-paste without reconsidering it.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **Loopback binding** — daemon never binds a public interface | `HIVE_HOST`/`DAEMON_HOST` = `127.0.0.1`, passed as `hostname` to `serve()` | `hive/src/shared/constants.ts:5` (`HIVE_HOST = "127.0.0.1"`), `hive/src/daemon/server.ts:89-93` (`serveFn({ fetch, hostname: hive.host, port: hive.port })`); `honeycomb/src/shared/constants.ts:17` (`DAEMON_HOST = "127.0.0.1"`) | OK |
| **Font/static asset routes** — no attacker-controlled path component reaches `fs` | Fixed 6-file allow-list; `join()` only ever receives a listed leaf name | `hive/src/daemon/dashboard/web-assets.ts:50-59` (`FONT_FILES`/`FONT_ALLOW`), `font(name)` returns `null` for anything not in the set (`web-assets.ts:212-219`); logo/CSS/app.js paths are hard-coded constants, never request-derived | OK |
| **Registry JSON write safety** — atomic, corruption-tolerant read/write | Temp file + `rename()`, `mkdirp` parent, malformed JSON degrades to empty rather than throwing | `hive/src/install/registry.ts:117-152` (`nextTempPath` + `fs.rename`, cleanup on failure), `parseRegistryDocument` swallows `JSON.parse` errors (`install/registry.ts:74-93`); reader side likewise (`daemon/registry.ts:42-62`) | OK (write); Low note on file mode above |
| **Federated wire fetch is loopback-confined** | Every daemon base resolves to `127.0.0.1`/`localhost`/`::1` only | Before fix: unrestricted `z.string().url()` on both server (`daemon/registry.ts`) and client (`wire.ts`) paths. After fix: `isLoopbackBaseUrl()` gate on both | FIXED — now OK |
| **No token/credential in the portal shell or wire client** | Shell HTML carries no secret; wire schemas structurally exclude a `token` field | `hive/src/daemon/dashboard/host.ts:89-107` (`renderShell()` — no inline data/token); `dashboard/web/wire.ts` schemas (e.g. `WhoAmISchema`, setup/login/migrate acks) are documented "NO token field by construction," verified no `Authorization`/`Bearer`/`localStorage` usage anywhere under `src/dashboard/web/` | OK |
| **CLI service-install has no shell-injection surface** | `execFile`/`execFileSync` with argv arrays only, no shell string concatenation; unit-file templates escape interpolated values | `hive/src/service/index.ts:52-75` (`createExecFileRunner` uses `execFile(command, [...args], ...)`), `service/commands.ts` builds fixed argv arrays (`launchctl`/`systemctl`/`schtasks`), `service/templates.ts` escapes all XML interpolation (`escapeXml`) and quotes the systemd `ExecStart` tokens (`quoteSystemdToken`); `execPath` is sourced from `fileURLToPath(import.meta.url)` in `cli.ts:65`, not user input | OK |
| **Honeycomb dashboard mount is actually retired (Decision A)** | `/` no longer serves the SPA/static bundle from honeycomb; only local-mode setup API routes remain | `honeycomb/src/daemon/runtime/assemble.ts:913-917` comment + code confirms the unprotected root group now hosts only `/setup/login`, `/setup/state`, `/setup/migrate-from-hivemind`; no `mountDashboardHost`/static-asset route found in `assemble.ts` or `server.ts` | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `hive/src/shared/daemon-routing.ts` | Added `isLoopbackBaseUrl()` (allow-lists `127.0.0.1`/`localhost`/`::1`/`[::1]`) as the shared loopback guard. |
| `hive/src/daemon/registry.ts` | `baseUrlFromHealthUrl()` now rejects a non-loopback `healthUrl` origin (returns `null` → fail-soft default) before it can become a daemon base. |
| `hive/src/dashboard/web/wire.ts` | `DaemonBasesSchema` adds `.refine(isLoopbackBaseUrl)` to both `honeycomb`/`nectar` fields — client-side defense in depth on `/api/daemon-bases` responses. |
| `hive/tests/wire/registry.test.ts` | Added a regression test proving a non-loopback `healthUrl` is dropped (`baseUrlFromHealthUrl` → `null`; the tampered entry never reaches `resolveDaemonBases`'s output). |

Since `hive/src` has no prior commit, there is no meaningful `git diff` baseline; the four edits above are the complete remediation change set for this session, and no other files were touched. `npx tsc --noEmit` and the full `npx vitest run` suite (12 files / 41 tests) both pass after the fix.

---

## Recommended Follow-Up (architectural)

- Consider an explicit `0600` file mode on `~/.honeycomb/doctor.daemons.json` writes (`install/registry.ts`) if the registry schema ever grows a sensitive field (Low finding above).
- No other architectural follow-up identified in this pass; `quality-worker-bee` may now run against a security-clean tree.
