# PRD-009d: Thin bootstrap companion (cross-repo)

> Parent: [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md)

## Overview

This sub-PRD scopes the cross-repo companion work in the honeycomb repository, where the canonical bootstrap lives (`scripts/install/install.sh`, mirrored as `install.ps1`, served at `https://get.theapiary.sh`). It is written from hive's side as an interface contract: what the bootstrap must do, hand off, and print for the portal onboarding flow to work. The implementation itself lands in the honeycomb repo against these requirements; nothing in this sub-PRD is hive code.

The human path shrinks to four moves: ensure Node (the existing fnm logic, unchanged), install hive alone at the manifest-pinned version, mint and hand off the one-time onboarding token and start the daemon, then open the browser and print the fallback line. The script asks nothing: it is piped (`curl ... | sh`), stdin is not a TTY, and no interactive prompt may exist anywhere on this path. The existing flag, env, and config machinery (`--products=`, `--profile=`, `--code=`, `--license=`, `--dry-run`, `--no-doctor`; env and `~/.honeycomb/install.conf` equivalents; precedence flag > env > config > preset > default `honeycomb,doctor`) is preserved for CI, headless, and admin use and is out of scope to change.

## Goals

- The zero-question human path: Node, hive, daemon, browser, one printed line.
- The token contract's bootstrap side: mint, hand to the daemon, embed in the opened URL.
- The headless/CI path is untouched: every existing flag and its behavior survives.

## Non-Goals

- Any hive daemon or portal behavior - [`prd-009a`](./prd-009a-installer-service-and-security.md) and [`prd-009b`](./prd-009b-onboarding-route-and-guided-flow.md).
- Changing the flag/env/config resolution, the profiles, the code table, or the `--dry-run` preview - all preserved as-is.
- Removing the script's own telemetry - its events continue for what the script itself does ([`prd-009c`](./prd-009c-onboarding-telemetry.md) tm-AC-6).
- Windows parity design beyond the requirement that `install.ps1` mirrors the same contract.

---

## User stories + acceptance criteria

### US-1 - the zero-question bootstrap

**As** a new operator, **when** I pipe the install script, **I** am never asked anything and end up in the portal.

| ID | Criterion |
|---|---|
| bs-AC-1 | Given the piped human path (no product-selection flags), when the script runs, then it performs exactly: ensure Node via the existing fnm logic, `npm i -g @legioncodeinc/hive` at the version pinned by `hive-release.json` (raw URL: `https://raw.githubusercontent.com/legioncodeinc/the-apiary/main/hive-release.json`), start the hive daemon, open the browser to the onboarding URL, and print the fallback line. It does not install honeycomb, doctor, or nectar. |
| bs-AC-2 | Given the piped context (stdin not a TTY), when the script runs end to end, then no code path on the human path reads from stdin or presents an interactive prompt. |
| bs-AC-3 | Given completion of the bootstrap, when the fallback prints, then it is exactly: `Click here if the portal doesn't open automatically: http://127.0.0.1:3853/onboarding` (the printed line carries the clean URL; the browser-open action carries the token variant). |
| bs-AC-4 | Given a machine where the browser cannot be opened (no display, no opener available), when the open step fails, then the script still prints the fallback line and exits successfully; the browser open is best-effort, the printed line is the contract. |

### US-2 - the token handoff

**As** the installer service's security model, **when** the bootstrap starts the daemon, **a** one-time token links this bootstrap run to this browser session.

| ID | Criterion |
|---|---|
| bs-AC-5 | Given the bootstrap, when it prepares the daemon, then it mints a cryptographically random one-time onboarding token, hands it to the daemon through the agreed out-of-band seam ([`prd-009a`](./prd-009a-installer-service-and-security.md): a file under `~/.honeycomb/hive/` at mode `0600` written before daemon start), and embeds it in the opened URL as `/onboarding?t=<token>`. |
| bs-AC-6 | Given the token, when the script's output and telemetry are inspected, then the token value is never echoed to stdout (the printed fallback line is token-free), never logged, and never included in any telemetry payload. |

### US-3 - the preserved headless path

**As** a CI pipeline or admin, **when** I pass flags, **the** script behaves exactly as it does before this PRD.

| ID | Criterion |
|---|---|
| bs-AC-7 | Given any invocation carrying the existing selection machinery (`--products=`, `--profile=`, `--code=`, `--license=`, `--dry-run`, `--no-doctor`, or their env/config equivalents), when the script runs, then the pre-existing behavior applies unchanged: full product resolution with precedence flag > env > config > preset > default `honeycomb,doctor`, direct npm installs of the selected products, doctor registration, and the `honeycomb install` handoff. The portal path activates only when no product selection was expressed. |
| bs-AC-8 | Given `install.ps1`, when the human path runs on Windows, then it mirrors the same contract (hive only, daemon start, token handoff, browser open, the exact fallback line). |

---

## Implementation notes

The decision seam is product-selection expression: an invocation that expresses a product selection (flag, env, config, code, or profile) takes the legacy full-install path; a bare invocation takes the portal path. This keeps one script serving both worlds without a breaking URL change at `get.theapiary.sh`. The pinned-hive-version fetch reuses the script's existing manifest download; if the manifest is unreachable the script should fail honestly on the human path rather than installing `@latest` (mirroring [`prd-009a`](./prd-009a-installer-service-and-security.md) is-AC-5).

## Related

- [`prd-009-onboarding-installer-index.md`](./prd-009-onboarding-installer-index.md) - module scope and the locked bootstrap-then-portal direction.
- [`prd-009a-installer-service-and-security.md`](./prd-009a-installer-service-and-security.md) - the daemon side of the token contract and the manifest refusal posture.
- [`prd-009c-onboarding-telemetry.md`](./prd-009c-onboarding-telemetry.md) - how the script's telemetry and the portal funnel divide the human path.
- honeycomb `scripts/install/install.sh` and `scripts/install/install.ps1` (cross-repo: [`../../../../../honeycomb/scripts/install/install.sh`](../../../../../honeycomb/scripts/install/install.sh)) - the scripts this contract governs.
- `../../../../../hive-release.json` - the pinned version manifest the bootstrap resolves hive's version from.
