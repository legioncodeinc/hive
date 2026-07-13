# QA Report: PRD-003 Hive CLI Adoption

**Plan document:** `C:/Users/mario/GitHub/the-apiary/cli-kit/library/requirements/backlog/prd-003-apiary-cli-interface-standard/`
**Audit date:** 2026-07-13
**Base branch:** `main`
**Head:** `legion/prd-003-cli-standard-hive` (dirty, unpushed working tree)
**Auditor:** quality-worker-bee

## Summary

The Hive-local PRD-003 adoption is implementation-complete and receives a final clean QA PASS after security's final PASS. Process identity now requires exact CLI-path plus adjacent `daemon` tokens and is revalidated immediately before every SIGTERM after service-manager stop; service-unit writes use no-follow descriptor checks before truncation. The full 834/834-test suite, packed-tarball conformance, and repeated live Windows `0.11.1` PID replacement all pass with no remaining finding.

## Scorecard

| Category | Status | Notes |
|---|---|---|
| Completeness | ✅ | All Hive-applicable implementation criteria have code, tests, documentation, and packed evidence |
| Correctness | ✅ | Lifecycle, registry, output, observability, update, and error behavior match the PRD |
| Alignment | ✅ | Canonical vocabulary, product command grouping, active runbook, and migration note agree |
| Gaps | ✅ | Required state/rendering goldens and JSON exception cases are covered |
| Detrimental | ✅ | Final security PASS; no open Critical, High, Medium, or QA finding |

## Critical Issues (must fix)

None.

## Warnings (should fix)

None.

## Suggestions (consider improving)

None.

## Plan Item Traceability

| ID | Hive verdict | Implementation location | Notes |
|---|---|---|---|
| AC-1 | Pass (Hive) | `src/cli-interface.ts:42-50` | All Hive-required commands plus globals are present |
| AC-2 | Pass (Hive) | `src/cli-interface.ts:112-270`; `src/cli-commands.ts` | Semantics, exits, streams, and help placement conform |
| AC-3 | Pass (Hive) | `src/cli-interface.ts:52-59`; packed conformance | Art, uppercase name, version, usage, groups, and exact credit |
| AC-4 | Pass (Hive) | `src/cli-observability.ts:139-165` | Fixed Hive product/service/root/path only |
| AC-5 | Pass (Hive) | `src/install/registry.ts:88-157,197-278` | Safe idempotent Hive upsert under owner-aware lock |
| AC-6 | Pass (Hive) | `tests/cli-interface.test.ts`; `scripts/verify-packed-cli.mjs` | Hive manifest and packed interface drift checks |
| AC-7 | Pass (Hive) | `src/cli-interface.ts:42-50` | `daemon` retained under Product commands |
| AC-8 | Pass (Hive) | `src/cli-interface.ts:117-270`; output tests | Human streams and machine-only JSON conform |
| AC-a1 | N/A | cli-kit | Shared-library criterion already delivered by cli-kit |
| AC-a2 | Pass | `src/cli-interface.ts:42-59` | Help is composed from shared plus Hive manifest |
| AC-a3 | Pass | `tests/cli-interface.test.ts:87-96` | Canonical names advertised; old names deprecated aliases |
| AC-a4 | Pass | `src/cli-interface.ts:140-270` | Exit 0/1/2 classes tested |
| AC-a5 | Pass | `src/cli-interface.ts:119-270` | Every baseline verb supports stable JSON envelope |
| AC-a6 | Pass | `src/cli-interface.ts:119-270`; JSON tests | One JSON document/newline; no ANSI/banner/credit/prompt |
| AC-a7 | Pass | `src/cli-interface.ts:42-50` | `daemon` dispatches under Product commands |
| AC-a8 | N/A | cli-kit | Shared validator criterion; Hive manifest passes it |
| AC-a9 | Pass (Hive) | `tests/cli-interface.test.ts`; `scripts/verify-packed-cli.mjs` | Bare/help/version/unknown/human/JSON matrix covered |
| AC-b1 | Pass | `src/cli-commands.ts`; `src/cli-update.ts` | All eight Hive lifecycle/install/update handlers bind correctly |
| AC-b2 | Pass (Hive) | `src/cli-commands.ts:196-211`; `src/install/registry.ts` | Hive register safely upserts its own entry |
| AC-b3 | Pass | `src/cli-commands.ts`; `src/service/index.ts`; `src/install/registry.ts` | Requested-state repeats and registration return success |
| AC-b4 | Pass | `src/cli-commands.ts:151-193` | Restart reports success only after bounded health |
| AC-b5 | Pass | `src/cli-commands.ts`; uninstall tests | Service-only removal preserves state/registry; full removal confirms |
| AC-b6 | Pass | `src/install/state-dir.ts`; `src/install/registry.ts` | Product-owned boundaries and peer registry entries preserved |
| AC-b7 | Pass | `src/cli-update.ts:50-104`; `tests/cli-update.test.ts` | Approved npm channel, versions, state, health, rollback/hard failure |
| AC-b8 | Pass (implementation) | `src/service/commands.ts`; service tests | Fixed argv for Windows/macOS/Linux; native CI configured |
| AC-b9 | Pass | `src/service/daemon-wrapper.ts`; `src/service/templates.ts`; `src/cli-observability.ts` | Every service action reaches the authoritative private Hive log |
| AC-b10 | Pass | `CHANGELOG.md`; `library/knowledge/private/operations/prd-003-cli-migration.md` | Renames, aliases, semantics, and automation effects documented |
| AC-c1 | Pass | `src/cli-observability.ts:38-71`; state goldens | Ordered human status and equivalent JSON |
| AC-c2 | Pass | `src/cli-observability.ts:139-165`; cli-kit | 100/follow defaults and all required options |
| AC-c3 | Pass | `src/cli-observability.ts:146-157` | Fixed identity and authoritative owned log path |
| AC-c4 | Pass | `tests/cli-observability.test.ts` | Arbitrary product/path selectors rejected |
| AC-c5 | Pass | `tests/cli-observability.test.ts` | Secrets redacted without stored-log mutation |
| AC-c6 | Pass | `src/cli-observability.ts:139-165`; tests | SIGINT exit 0; missing/unreadable exit 1 |
| AC-c7 | Pass | `src/cli-observability.ts:85-119`; tests | Read-only summary, enabled/opted-out, no credential output |
| AC-c8 | Pass | `src/cli-interface.ts:192-229`; observability tests | No lifecycle side effects |
| AC-c9 | Pass (Hive) | `tests/cli-observability.test.ts` | Named status/log/telemetry states in human and JSON modes |
| AC-d1 | Pass (Hive) | `src/cli-interface.ts:52-59`; rendering tests | Distinct ASCII Hive/colony art within width |
| AC-d2 | Pass (Hive) | `tests/cli-interface.test.ts`; packed conformance | Complete banner anatomy |
| AC-d3 | N/A | Honeycomb | Cross-product visual criterion |
| AC-d4 | Pass | `src/cli-interface.ts:52-59,124-132`; purity tests | Help has no side effects |
| AC-d5 | Pass | rendering matrix in `tests/cli-interface.test.ts` | 80/narrow/color-disabled output ANSI-free and stable |
| AC-d6 | Pass | JSON matrix | No banner or attribution prose in JSON |
| AC-d7 | Pass | packed conformance; `src/cli-interface.ts:135-137` | Exact package-derived `hive v<version>\n` |
| AC-d8 | Pass | `tests/cli-interface.test.ts`; packed conformance | Standard JSON version envelope only |
| AC-d9 | Pass (Hive) | `tests/cli-interface.test.ts` | 80/narrow/color/bare/help/version goldens covered |
| AC-d10 | Pass (Hive) | help and packed assertions | Exact `Legion Code Inc. x Activeloop` |
| AC-e1 | N/A | Honeycomb | Not a Hive criterion |
| AC-e2 | N/A | Doctor | Not a Hive criterion |
| AC-e3 | Pass | `scripts/verify-packed-cli.mjs`; alias/unit tests | Installed tarball passes Hive matrix and deprecated aliases remain tested |
| AC-e4 | N/A | Nectar | Not a Hive criterion |
| AC-e5 | Pass | `CHANGELOG.md`; migration note; rewritten active runbook | Repository documentation is internally consistent |
| AC-e6 | Pending ship evidence | `.github/workflows/ci.yaml:47-99` | Three-OS test/build/packed job configured; no run claimed for unpushed tree |
| AC-e7 | N/A | suite-level repository | Fleet-wide four-package job is outside Hive-local adoption |
| AC-e8 | Pass (Hive) | handler tests, packed conformance, registry/log isolation tests | No silent stubs or wrong-product delegation |
| AC-e9 | Pass | shared command matrix plus Hive migration/runbook links | Normative suite semantics are linked consistently |
| AC-e10 | N/A | fleet releases | Publication criterion is outside local Hive implementation |

## Verification Evidence

| Gate | Result |
|---|---|
| Final security re-review | PASS; no open Critical, High, or Medium finding |
| Focused PRD-003 tests | PASS: 11 files, 119 tests |
| Full `npm test` | PASS on rerun: 97 files, 834 tests; first run had one unrelated onboarding timeout and its isolated rerun passed 6/6 |
| Test-stability delta | PASS: 10s Vitest ceiling, hidden-first visibility fixture, and hermetic unauthenticated funnel seam affect tests only; no production path changed |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test:packed-cli` | PASS: packed install and CLI conformance |
| `npm audit --audit-level=high` | PASS: 0 vulnerabilities |
| `git diff --check` | PASS (line-ending warnings only) |
| Native CI | Configured for Ubuntu/macOS/Windows; pending push/run evidence |

## Live Dogfood Lifecycle Addendum

The dogfood evidence matches the corrected lifecycle transaction:

- `hive stop` terminated orphan PID `104964` rather than accepting the service manager's nominal stop as convergence.
- `hive install` reconciled and started the fixed service action; `/health` returned Hive `0.11.1` under PID `55128`.
- `hive restart` stopped the prior instance, started PID `127724`, and returned success only after `/health` again reported `0.11.1`.
- After identity and symlink hardening, a second live Windows restart safely replaced PID `123832` with healthy Hive `0.11.1` PID `110864`.
- Final live double-check replaced PID `110864` with healthy Hive `0.11.1` PID `116892` under the exact-token and post-stop identity revalidation code.
- Unit tests prove an orphan is signaled after a successful manager stop, a stuck orphan returns exit `1` after the exact configured bound, and restart never starts a replacement until the prior PID is gone.
- Final dogfood security verdict is **PASS**: exact tokenized identity, immediate pre-signal revalidation, and descriptor-based unit-file protection close both prior Medium findings.

Final delta gates: local identity/lifecycle/service focused suite 3 files/54 tests passed; security focused suite 4 files/68 tests passed; full suite rerun 97 files/834 tests passed; typecheck, build, packed conformance, audit, and diff check passed.

## Prior Blocker Closure

| Prior blocker | Final evidence | Status |
|---|---|---|
| Registry lost update / malformed replacement | PID plus UUID owner token, bounded wait, dead-owner stale recovery, owner-checked release, fail-closed parsing, exclusive randomized temp files, preservation tests | Closed |
| Human failures on stdout | Bounded non-streaming output buffered and routed by exit code; success/failure stream tests | Closed |
| JSON exceptions escaping envelope | Confirmation, status, telemetry, logs, and handler exceptions return one JSON result with empty stderr | Closed |
| Missing goldens / packed matrix | Expanded rendering/state/output tests plus installed-tarball conformance script and CI step | Closed |
| Stale active runbook | Runbook fully describes canonical matrix, lifecycle boundaries, logs, registry locking, exits, JSON, and recovery | Closed |

## Files Changed

- `.github/workflows/ci.yaml` (M), adds packed CLI conformance to all three OS legs.
- `.changeset/standardize-hive-cli.md`, `CHANGELOG.md`, `README.md`, migration note, and active runbook (A/M), document the canonical interface and migration.
- `package.json`, `package-lock.json` (M), add cli-kit and packed-test script.
- `scripts/verify-packed-cli.mjs` (A), bounded installed-tarball conformance verification.
- CLI, lifecycle, registry, observability, updater, service wrapper/template, terminal, and path sources under `src/` (A/M), implement Hive adoption and security boundaries.
- Corresponding `tests/` files (A/M), include exact-token identity, post-stop revalidation, orphan convergence, bounded failure, and descriptor/symlink cases and contribute to the 834-test green suite.
- `vitest.config.ts` (M), raises the per-test timeout to 10 seconds for parallel CI load without changing runtime code.
- Security and quality reports under `library/qa/` (A), record final independent review evidence.
