# PRD-003 CLI migration

> Category: Operations | Date: July 2026 | Status: Active | Audience: Hive operators and automation maintainers

Hive adopted the shared Apiary CLI interface contract. This note is the migration boundary for operators who used Hive's earlier narrow dispatcher. It documents observable behavior; product internals remain owned by Hive.

## Canonical surface

| Group | Canonical commands | Ownership |
|---|---|---|
| Service lifecycle | `start`, `stop`, `restart`, `status`, `logs` | Operate or inspect the installed Hive service. |
| Installation | `install`, `uninstall`, `service-install`, `service-uninstall`, `update` | Separate product onboarding/removal from OS-service-only changes. |
| Fleet | `register` | Idempotently upsert Hive's own Doctor registry entry. |
| Diagnostics | `telemetry` | Read-only telemetry configuration and delivery summary. |
| Product commands | `daemon` | Run Hive directly in the foreground. |
| Global options | `--help`, `--version`, `--json`, `--no-color` | Shared presentation and machine-output controls. |

Bare invocation and `--help` render Hive-specific ASCII art, the uppercase product name `HIVE`, package-derived version, usage, grouped commands, and the exact credit `Legion Code Inc. x Activeloop`. `--version` writes exactly `hive v<package-version>` followed by one newline.

## Breaking semantic changes

### `start` versus `daemon`

Before this migration, `hive start` was the foreground portal process and remained attached to the terminal. It now controls the already-installed OS service. If no service is installed, it fails and directs the operator to `hive service-install`; it does not silently launch a detached process.

Use `hive daemon` when the process must remain in the foreground, including local development, containers, and an external supervisor that owns the process directly.

Automation migration:

```text
before: hive start
after, installed service: hive start
after, foreground process: hive daemon
```

The command text is unchanged for service startup but its precondition and process lifetime are different. Any script that waited on the old foreground `start` process must change to `daemon`.

### `install` versus `service-install`

`hive install` is the product onboarding transaction. It reconciles Hive's OS service and registers Hive with Doctor, reporting those phases as product setup. It is not an npm-global package installer.

`hive service-install` owns only the OS service definition. It must not perform login, delete state, or register Hive with Doctor. This makes service repair safe when onboarding and registry state are already correct.

The removal boundary is symmetrical:

- `hive service-uninstall` stops and removes only the OS service definition. Hive state and Doctor registration remain intact.
- `hive uninstall` is the full Hive removal transaction. It stops Hive, deregisters Hive, removes the service, and removes only Hive-owned state selected by the retention policy. It must never remove shared credentials, another Doctor registry entry, or another product's `~/.apiary/<name>` directory.

### Renamed service verbs

The primary spellings are noun-last:

| Deprecated alias | Canonical command |
|---|---|
| `install-service` | `service-install` |
| `uninstall-service` | `service-uninstall` |

The old spellings remain dispatchable as deprecated aliases for the migration window, but they are absent from primary help. New documentation and automation must use the canonical commands now; do not depend on the aliases remaining indefinitely.

## Output and exit behavior

Every baseline operational command accepts `--json`. The machine form emits exactly one JSON document with one trailing newline and at least these fields:

```json
{
  "product": "hive",
  "command": "status",
  "ok": true,
  "message": "Hive status"
}
```

Command-specific facts appear in additional fields. JSON mode emits no ANSI, banner, credit, prompt, spinner, or prose outside the document. For automation, prefer `--json` and parse fields rather than matching a human sentence.

| Exit | Meaning | Automation response |
|---:|---|---|
| `0` | Success, informational result, or requested idempotent state already satisfied. | Continue; inspect JSON fields when the distinction matters. |
| `1` | Runtime, service-manager, update, health, log-read, or other operational failure. | Retry only when the underlying operation is safe; surface `message`. |
| `2` | Unknown command, malformed option, missing argument, or other usage error. | Fix the invocation; do not retry unchanged. |

Human output is an operator surface, while unknown-command and usage diagnostics use stderr. Deprecated-alias warnings are also human diagnostics; automation should migrate and consume `--json` rather than parse streams or prose.

## Observability commands

### `status`

`hive status` is a bounded, read-only snapshot. Human output reports product/version, service installation, process/PID, health, Doctor registration, known update state, and Hive config/log paths in a stable order. `status --json` returns the same facts structurally. A stopped but installed service is a successful query. Status never starts or restarts Hive.

### `logs`

`hive logs` is hard-bound to Hive's validated service identity and authoritative log destination; it cannot be redirected to another product or an arbitrary path through the standard command.

Defaults and options:

- last 100 lines, then follow;
- `--lines <n>` changes the initial tail;
- `--no-follow` returns after the bounded read;
- `--since <duration-or-timestamp>` filters older entries;
- Ctrl+C ends follow mode cleanly with exit `0`;
- missing or unreadable Hive logs produce a concise exit `1` failure;
- recognized authorization, bearer-token, API-key, and credential values are redacted in terminal output without modifying the stored log.

JSON log requests are bounded so the command can emit one complete JSON document rather than an endless stream.

### `telemetry`

Bare `hive telemetry` is read-only. It reports enabled/opted-out state, the controlling setting, destination class, available queue/delivery health, and how to opt out. It never prints credentials and never starts or restarts Hive. Existing fleet/dashboard telemetry behavior is separate from this CLI status summary.

## Operator checklist

- Replace foreground `hive start` calls with `hive daemon`.
- Replace `install-service` and `uninstall-service` with the canonical service verbs.
- Decide whether each installer call means full onboarding (`install`) or service-only reconciliation (`service-install`).
- Treat exit `2` as an invocation defect and exit `1` as an operational defect.
- Add `--json` wherever output is parsed by a script.
- Use `logs --no-follow` for bounded automation; use follow mode only for interactive tails.
- Do not assume `service-uninstall` deregisters Hive or deletes Hive state.
- Snapshot or update any help/version assertions to include the shared Hive banner anatomy and exact credit.

## Related

- [CLI and runbook](./cli-and-runbook.md) — historical operational detail; where it conflicts with this migration note, the PRD-003 surface documented here is authoritative.
- [Doctor registration and lifecycle](../architecture/doctor-registration-and-lifecycle.md)
- [Telemetry egress](../telemetry/telemetry-egress.md)
- [On-disk footprint](./on-disk-footprint.md)
