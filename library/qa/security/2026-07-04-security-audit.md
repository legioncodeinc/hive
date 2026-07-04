# Security Audit: feature/apiary-root-and-nectar-activation (uncommitted working tree)

> Category: Security Audit | Version: 1.0 | Date: July 2026 | Status: Active

Audit of the uncommitted working-tree changes in the hive repo implementing PRD-010 (fleet root, legacy paths, registry paths, state migration, lock legacy liveness, boot ordering, service templates) and nectar PRD-019c (dashboard NectarProjectsPanel + wire methods). Performed by security-worker-bee, before quality-worker-bee (pre-flight confirmed: `library/qa/` holds no QA report for this branch newer than HEAD).

**Scope note:** the target is the hive portal (React dashboard + Hono loopback daemon + fleet filesystem paths), not the Hivemind CLI/MCP stack the security-stinger catalogs verbatim. The same threat classes were applied (injection, XSS, credential exposure, SSRF, CSRF, path and permission hygiene, supply chain). There is no SQL or captured-trace surface in this branch.

## Executive summary

No Critical or High findings. Three Medium/Low findings were remediated in place (state-dir mode parity in the lock path, relative `XDG_STATE_HOME` cwd-anchoring rejection, registry mkdirp mode parity). One Medium posture finding (CSRF on the local-mode dashboard POST surface) is documented, not fixed: the new brooding toggle exactly matches the pre-existing posture of every state-changing endpoint on this surface, and the correct fix is a systemic change to the shared BFF proxy that exceeds this branch's blast radius. Gates: `npm run typecheck` clean, `npm test` 384 passed (383 baseline + 1 added regression test), `npm audit --omit=dev` 0 vulnerabilities.

## Findings

| # | Severity | Location | Class | Description | Remediation |
|---|---|---|---|---|---|
| F-1 | Medium | `src/lock.ts:72` | Insecure default permissions (CWE-276) | `acquireSingleInstanceLock` created the hive state dir without `mode: 0o700`, contradicting the mg-AC-4 claim whenever this mkdir is the first creator of the dir (migration seam injected as a no-op, or a standalone caller). The same dir later holds the 0600 onboarding token. | FIXED: `mode: 0o700` added to the mkdir. |
| F-2 | Medium | `src/shared/apiary-root.ts:34` | Path resolution, cwd anchoring | A relative `XDG_STATE_HOME` (invalid per the XDG Base Directory spec, which requires absolute values) was joined verbatim, yielding a RELATIVE fleet root. Every consumer (registry `pidPath`, lock dir, stale-lock `rmSync`, staged task path) would then resolve against `process.cwd()`, violating the branch's own "never reads `process.cwd()`" invariant and the ADR "absolute pidPath" decision. | FIXED: relative XDG values are ignored per spec (falls back to `<home>/.apiary`); regression test added in `tests/shared/apiary-root.test.ts`. |
| F-3 | Low | `src/install/registry.ts:56` | Insecure default permissions | `createNodeRegistryFs.mkdirp` created the registry parent dir (the fleet root, or legacy `~/.honeycomb` on a fresh box) at umask defaults, while the migration path creates the same dirs at 0o700. Divergent modes depending on which writer runs first. | FIXED: `mode: 0o700` added for parity (one line). |
| F-4 | Medium | Posture: `src/daemon/proxy.ts` (all methods pass through), nectar `src/api/router.ts` (`allowAllPermission`) | CSRF (CWE-352) | The new `POST /api/hive-graph/projects/brooding` has no CSRF defense: no Origin or Host validation at the hive proxy or nectar router, no anti-forgery token, and nectar parses the raw body as JSON regardless of content-type, so a cross-site `no-cors` fetch or HTML form POST from a hostile page can forge the toggle against `127.0.0.1:3853`. HONEST FLAG: this exactly matches the existing local-mode posture of every state-changing endpoint on this surface (`/api/hive-graph/build`, `/api/hive-graph/search`, `/api/pollinate`, and the honeycomb-proxied settings/secrets writes), so the new POST is posture-consistent, and the posture itself is weak. Mitigating factors: loopback-only bind; modern Chromium Local Network Access blocks public-to-local subresource requests; forged responses are unreadable cross-origin; the toggle itself is low-sensitivity (pause/resume brooding). | DOCUMENTED. Recommended follow-up (dedicated hardening change, not this branch): reject state-changing methods at the BFF proxy when an `Origin` header is present and is not hive's own origin; non-browser callers send no Origin and are unaffected. Changing this here would alter behavior of the entire pre-existing `/api/*` surface, which violates minimal blast radius for this audit. |
| F-5 | Low | `src/shared/state-migration.ts:32-56` | Symlink following (CWE-59) | `copyFileSync` follows a symlink planted at a legacy filename and would copy the target's content into the new state dir; a dangling symlink pre-planted at the destination would be written through. Exploitation requires write access inside the user-owned 0o700 legacy or new state dirs, i.e. an attacker already running as the user, at which point nothing here adds capability. The `rmSync` calls are non-recursive with `force: true` on exactly the resolved filenames: a symlinked source has only the link removed (never the target), and no rm can reach outside the two resolved state dirs. | DOCUMENTED, no fix. The attacker model (user-level write access to 0o700 user-owned dirs) already implies full user compromise. |
| F-6 | Info | `src/daemon/installer/token.ts` | Onboarding token dual-read window | The token now validates from the new path first, legacy second (mg-AC-9). Two live 0600 token files can coexist during the window, slightly widening acceptance; however `invalidate()` now deletes BOTH paths, so completion can never leave a resurrectable legacy token. Constant-time comparison (`timingSafeEqual`, equal-length guard) unchanged; the token is never logged, echoed, or placed in an error body in any changed code. | None needed. |

## Categories checked with no findings

- **Dashboard XSS:** every newly rendered value (nectar `project.name`, `projectId`, `path`, brooding labels, bind-ack errors, browse paths) renders as React text children or attributes, auto-escaped; no `dangerouslySetInnerHTML`, `innerHTML`, or `eval` anywhere in `src/`. None detected.
- **Wire zod boundaries:** `NectarProjectsBodySchema` / `NectarProjectRowSchema` / `NectarProjectCountsSchema` are fail-soft (`.catch()` at every level); a malformed or hostile body degrades to `UNREACHABLE_NECTAR_PROJECTS`, never throws into React. Both new wire methods `safeParse` before use. None detected.
- **Secrets riding request bodies:** the brooding POST body is exactly `{ projectId, brooding }` or `{ global }`; browse/bind bodies carry path and name only; headers are the fixed, non-secret dashboard session identifiers. None detected.
- **SSRF via the BFF proxy:** `/api/hive-graph/*` ownership resolves to nectar via a fixed prefix match on the URL-parser-normalized pathname (dot segments collapse before matching, so a crafted path cannot select a different origin); the daemon base comes from the registry through zod URL validation plus `isLoopbackBaseUrl` at parse time AND a second loopback re-check at proxy time; `redirect: "error"` pins the fetch. A tampered registry entry naming a non-loopback host is dropped before it can become a base. None detected.
- **Registry writes:** `pidPath` is now an absolute resolved path (`resolveHiveRegistryPidPath`), replacing the previous unresolvable `"~/.honeycomb/hive.pid"` literal; write is atomic temp-then-rename in the same directory with temp cleanup on rename failure; the only env-derived values entering the JSON are resolved paths, serialized through `JSON.stringify`. None detected (after F-2/F-3 fixes).
- **Stale-lock rm scope:** `removeStaleLegacyLockArtifacts` removes exactly the two resolved legacy filenames, non-recursively, only after the new lock is held; legacy lock removal is gated behind a pid-liveness check that throws `DaemonAlreadyRunningError` for a live legacy daemon. Nothing can delete outside the resolved state dirs. None detected.
- **Windows staged task and launchd XML:** all interpolated values (`process.execPath`, plan exec path, task name, and the new fleet-root-derived launchd log paths, which are `APIARY_HOME`-influenced) pass through `escapeXml`; `schtasks`/`launchctl`/`systemctl` are invoked via `execFile` argv arrays, never a shell string. None detected.
- **APIARY_HOME resolution:** trimmed, absolute-or-resolved-against-home, XDG honored only on Linux and only when absolute (F-2 fix), never `process.cwd()`, never shell-interpolated. None detected (after F-2).
- **Boot ordering:** migrate, then lock+pid, then best-effort registry upsert in the same boot; a registry failure is fail-soft and cannot block or crash boot. None detected.
- **Test hygiene:** `tests/setup/isolate-home.ts` points `HOME`/`USERPROFILE` at a fresh mkdtemp dir and clears `APIARY_HOME`/`XDG_STATE_HOME` before any module loads; no test touches the real home. None detected.
- **Hidden Unicode in changed files:** scan of the full diff plus all untracked files found no zero-width, bidi, or BOM characters. None detected.
- **Telemetry PII:** payload remains the closed allow-list `{package, version, os, arch, node}`; the added legacy install-id read only supplies an anonymous UUID `distinct_id` source. None detected.
- **Supply chain:** no new dependencies introduced by the branch; `npm audit --omit=dev` reports 0 vulnerabilities. None detected.

## Remediation diff (security-worker-bee edits only)

- `src/lock.ts`: `mkdirSync(dirname(lockFilePath), { recursive: true, mode: 0o700 })` (was mode-less).
- `src/shared/apiary-root.ts`: relative `XDG_STATE_HOME` ignored (`isAbsolute` guard) with an explanatory comment.
- `src/install/registry.ts`: `mkdirp` applies `mode: 0o700`.
- `tests/shared/apiary-root.test.ts`: added regression test "ignores a relative XDG_STATE_HOME".

## Gate outputs

- `npm run typecheck`: clean (exit 0).
- `npm test`: 56 files, 384 tests passed (baseline 383 plus the added F-2 regression test), 0 failed.
- `npm audit --omit=dev`: found 0 vulnerabilities.

## Verdict

No Critical or High findings remain. Medium F-4 (CSRF posture of the local-mode POST surface) is documented with a recommended systemic follow-up; it predates this branch and the new endpoint conforms to the existing posture. quality-worker-bee may now run.
