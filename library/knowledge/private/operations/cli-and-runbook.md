# CLI and runbook

> Category: Operations | Version: 2.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

Hive follows the suite-wide Apiary CLI contract. The normative command meanings live in the shared PRD; [PRD-003 CLI migration](./prd-003-cli-migration.md) owns migration and automation guidance. This runbook covers Hive-specific operating details only.

## Operator commands

```text
hive start                Start the installed Hive service
hive stop                 Stop it
hive restart              Restart it and wait for http://127.0.0.1:3853/health
hive status               Inspect installation, PID, health, registration, and paths
hive logs                 Tail the Hive-owned service log
hive install              Install/reconcile the service and register Hive with Doctor
hive uninstall            Confirm and remove Hive's service, registration, and owned state
hive service-install      Install/reconcile only the OS service
hive service-uninstall    Remove only the OS service; preserve state and registration
hive update               Install the approved npm release and verify or roll back
hive register             Upsert only Hive's Doctor registry entry
hive telemetry            Inspect telemetry state without changing it
hive daemon               Run the portal in the foreground
```

Bare invocation and `--help` show the full grouped reference. Use `--json` for automation. Exit `0` means success or an already-satisfied idempotent state, `1` means an operational failure, and `2` means invalid usage. Full uninstall requires an interactive confirmation or explicit `--yes`; `uninstall --json` requires `--yes`.

The compatibility aliases `install-service` and `uninstall-service` still dispatch with a deprecation warning. Do not use them in new automation.

## Service and process model

The service definition on launchd, systemd, and Windows Task Scheduler invokes the fixed internal `service-daemon` action. That wrapper launches `hive daemon` without a shell, forwards termination signals, and opens Hive's authoritative service log with symlink and regular-file checks. The foreground daemon owns the single-instance lock and PID file and binds only `127.0.0.1:3853`.

`hive start` never falls back to a foreground process. If the service is absent, run `hive service-install` or the full `hive install` transaction. For local development, containers, or an external supervisor, run `hive daemon` (or `npm start`, which maps to that command).

## Paths

The root resolution chain is `APIARY_HOME`, then Linux `XDG_STATE_HOME/apiary` when explicitly configured, then `~/.apiary`.

| Artifact | Default path |
|---|---|
| Hive state | `~/.apiary/hive/` |
| PID | `~/.apiary/hive/hive.pid` |
| Lock | `~/.apiary/hive/hive.lock` |
| Service log | `~/.apiary/hive/service.log` |
| Doctor registry | `~/.apiary/registry.json` |

Hive mutates only its own registry entry and state directory. Registry writes use a bounded inter-process lock plus atomic temp-file rename and fail closed on malformed JSON, preserving other products' entries. Never repair the registry by deleting peer entries; use `hive register` after correcting the malformed document or lock condition.

## Inspect a running Hive

Start with the CLI:

```text
hive status
hive logs --lines 100 --no-follow
hive telemetry
```

The local HTTP probes are also available:

```bash
curl -s http://127.0.0.1:3853/health
curl -s http://127.0.0.1:3853/api/fleet-status
curl -s http://127.0.0.1:3853/api/registered-services
```

`hive logs` is hard-bound to `service.log`, redacts recognized credentials in emitted text, and never alters the stored file. It follows by default; Ctrl+C ends follow mode cleanly. Use `--no-follow` in scripts.

## Common failures

- **Service is not installed.** Run `hive service-install` for service-only repair or `hive install` when Doctor registration should also be reconciled.
- **Restart does not become healthy.** `hive restart` exits `1` after its bounded health window. Inspect `hive status` and `hive logs --no-follow`; it never reports an unverified restart as success.
- **Update health fails.** Hive attempts an exact-version rollback and reports whether recovery succeeded. A failed rollback is a hard failure requiring manual package repair.
- **Registry is locked.** Another cooperating process is updating the shared registry. Retry after the bounded lock holder finishes; Hive fails instead of overwriting a concurrent update. A stale lock is reclaimed only after its recorded owner process is no longer alive.
- **Registry JSON is malformed.** Hive fails closed and does not replace the file. Preserve and repair the document, then rerun `hive register`.
- **`hive is already running (pid N)`.** A foreground daemon already owns the lock. If the PID is dead, the next daemon start reclaims the stale lock automatically.
- **Dashboard remains on `/buzzing`.** Doctor or a required peer is not healthy. Check `/api/fleet-status` and the peer's own status/logs.
- **Dashboard redirects to `/login`.** The Honeycomb authentication/setup probe is unauthenticated or failed closed.

## Environment controls

- `APIARY_HOME` selects an absolute fleet state root.
- Linux `XDG_STATE_HOME` supplies the fallback fleet root when explicitly set.
- `HONEYCOMB_TELEMETRY=0` or a nonzero/nonempty `DO_NOT_TRACK` opts out of telemetry.

Host, port, health endpoint, service identity, registry product name, and log source are fixed product constants and cannot be redirected through CLI arguments.

## Related

- [PRD-003 CLI migration](./prd-003-cli-migration.md)
- [On-disk footprint](./on-disk-footprint.md)
- [Doctor registration and lifecycle](../architecture/doctor-registration-and-lifecycle.md)
- [Telemetry egress](../telemetry/telemetry-egress.md)
