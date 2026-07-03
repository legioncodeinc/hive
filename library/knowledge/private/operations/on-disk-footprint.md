# On-Disk Footprint

> Category: Operations | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

Read this if you operate hive, debug a stuck instance, or audit what hive writes: it catalogs every file hive reads or writes, each file's format, who owns it, and its lifecycle, so you know exactly what a hive install touches on disk.

**Related:**
- [cli-and-runbook.md](./cli-and-runbook.md)
- [../architecture/doctor-registration-and-lifecycle.md](../architecture/doctor-registration-and-lifecycle.md)
- [../telemetry/telemetry-egress.md](../telemetry/telemetry-egress.md)
- [../architecture/shared-contracts-and-routing.md](../architecture/shared-contracts-and-routing.md)
- [../security/trust-boundaries.md](../security/trust-boundaries.md)
---

## The footprint is small on purpose

Hive persists almost nothing. It holds no Deep Lake client and no application database; every row the dashboard renders comes from another daemon. What hive writes is limited to a lock/pid pair, an idempotent entry in doctor's shared registry, a telemetry dedupe ledger, and (when installed as a service) an OS unit file plus its logs. Everything lives under the shared `~/.honeycomb` home directory, pinned as `HONEYCOMB_HOME_DIR = join(homedir(), ".honeycomb")` in `src/shared/constants.ts`. This doc is the exhaustive list.

```
~/.honeycomb/
  hive.lock                 # hive writes: PID, exclusive-create lock (removed on clean stop)
  hive.pid                  # hive writes: PID mirror the registry entry points at
  doctor.daemons.json       # doctor owns; hive upserts its own entry (read-modify-write, atomic)
  install-id                # honeycomb owns; hive READS it for telemetry distinct_id correlation
  hive/                      # hive's own state dir, mode 0o700
    install-id              # hive writes: fallback distinct_id when the shared one is absent
    telemetry.json         # hive writes: telemetry dedupe ledger + last-seen version
    launchd.out.log        # hive (via launchd) writes: stdout, macOS only
    launchd.err.log        # hive (via launchd) writes: stderr, macOS only
    hive-task.xml          # hive writes: staged Windows Scheduled Task XML, Windows only
~/Library/LaunchAgents/com.legioncode.hive.plist   # hive writes: macOS unit (install-service)
~/.config/systemd/user/hive.service                # hive writes: Linux unit (install-service)
~/.deeplake/credentials.json                        # honeycomb owns; hive NEVER reads it (auth is honeycomb's)
```

## The lock and pid pair

`hive.lock` and `hive.pid` are the single-instance guard, written by `acquireSingleInstanceLock` (`src/lock.ts`) before the socket binds. The lock is opened with the `wx` flag (exclusive create): success means this process owns the instance, and it writes its PID into the lock and mirrors it to `hive.pid`. On `EEXIST` it reads the existing PID and probes it with `process.kill(pid, 0)`; a live process (including `EPERM`, which means alive-but-not-ours) throws `DaemonAlreadyRunningError`, and a dead PID means a stale lock that is removed and reclaimed exactly once. Both files are plain text holding just the decimal PID. Both are removed on a clean stop (`releaseSingleInstanceLock`, called on `SIGINT`/`SIGTERM` and on server close). Because the guard is PID-probe based rather than flock-based, a crashed daemon's lock reclaims itself on the next start with no manual cleanup. The constants are `HIVE_LOCK_PATH` and `HIVE_PID_PATH`; `tests/lock.test.ts` pins acquisition, stale reclaim, and the race.

## The doctor registry entry

`doctor.daemons.json` is doctor's file, not hive's, but hive is one of its writers. `registerHiveWithDoctor` (`src/install/registry.ts`) upserts exactly hive's own entry and leaves every other daemon's entry byte-for-byte alone. The entry hive writes is fixed:

```typescript
export function buildHiveRegistryEntry(): RegistryDaemonEntry {
  return {
    name: "hive",
    healthUrl: "http://127.0.0.1:3853/health",
    pidPath: "~/.honeycomb/hive.pid",
    probeIntervalMs: 30_000,
    startupGraceMs: 60_000,
    restartGiveUpThreshold: 3,
    restartCooldownMs: 5_000
  };
}
```

The write is a read-modify-write with real idempotence: an existing `name: "hive"` entry is merged in place (`{ ...existing, ...hiveEntry }`, preserving any extra keys doctor added), a missing one is appended. The whole document is written atomically: serialize to `doctor.daemons.json.tmp-<pid>-<ts>`, then `rename` over the original, removing the temp file on a failed rename. A corrupt or missing registry parses to an empty document rather than an error, so registration works on a box where doctor has never run. Hive also reads this file (never through the writer path) to resolve daemon bases and the registered-service-name list, always zod-validated and loopback-filtered; those reads are documented in [../integrations/workload-endpoint-inventory.md](../integrations/workload-endpoint-inventory.md).

`pidPath` in the entry points at the same `hive.pid` the lock mirrors, so the supervisor and the lock agree on which process is "the" hive. Note the asymmetry: `uninstall-service` never removes this entry. After an uninstall the entry lingers and doctor keeps probing; removing it is a manual edit.

## The telemetry state dir

Hive's own state dir, `HIVE_STATE_DIR = join(HONEYCOMB_HOME_DIR, "hive")`, is created lazily with mode `0o700` and holds the telemetry bookkeeping. Two files:

- `telemetry.json` (`LEDGER_FILENAME`) is the dedupe ledger. Its `reported` map keys a dedupe key (an event name, or `hive_updated@<version>`) to the ISO timestamp it was sent, and `lastSeenVersion` records the version seen on the most recent lifecycle-recorded `start`, used to detect upgrades. It is written with `saveLedger` (which creates the dir at mode `0o700`) and reads fail-soft to an empty ledger on any IO or parse problem.
- `install-id` (`INSTALL_ID_FILENAME`) is hive's own generated anonymized `distinct_id`, a UUID, persisted best-effort. It is only used when the shared `~/.honeycomb/install-id` is absent.

Both files hold no secret and no machine-identifying string. The full egress story, including the closed five-key property allow-list, is in [../telemetry/telemetry-egress.md](../telemetry/telemetry-egress.md).

## The shared install-id (read-only)

`~/.honeycomb/install-id` (`SHARED_INSTALL_ID_PATH`) is written by the honeycomb installer, not by hive. Hive reads it (never writes it) to prefer it as the telemetry `distinct_id`, so hive's lifecycle events correlate with the honeycomb install funnel. When it is absent, hive falls back to its own generated id above.

## The OS service unit and its logs

`hive install-service` writes one unit file per platform (`src/service/`), rendered by `src/service/templates.ts` and placed by `src/service/platform.ts`:

| Platform | Unit path | Format |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.legioncode.hive.plist` | launchd plist, `RunAtLoad` + `KeepAlive`, `ThrottleInterval` 5s, stdout/stderr to `~/.honeycomb/hive/launchd.{out,err}.log` |
| Linux | `~/.config/systemd/user/hive.service` | systemd user unit, `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0`, `WantedBy=default.target` |
| Windows | staged at `~/.honeycomb/hive/hive-task.xml`, then registered as task `hive` | Scheduled Task XML, `LogonTrigger`, `RestartOnFailure` every `PT1M` up to 999, `MultipleInstancesPolicy: IgnoreNew` |

Each unit runs `node <cli.js> start`. `uninstall-service` removes the unit file and deregisters the unit; the launchd log files and the staged XML are left where they are (harmless residue). The legacy pre-decision-#32 unit paths (`thehive`) are removed best-effort at the start of every install so a re-run migrates rather than racing.

## What hive never touches

Hive never reads `~/.deeplake/credentials.json`. That is honeycomb's credential file; "logged in" for the portal is honeycomb's `/setup/state` bit, which hive reads over loopback and holds nothing from. Hive writes no Deep Lake dataset, no application database, and no cache of workload data: every panel re-fetches through the proxy on its poll interval. An always-on process that stores no secret has no secret to leak, which is the security posture [../security/trust-boundaries.md](../security/trust-boundaries.md) hangs on. The one file-permission gap (hive does not tighten the registry file's permissions) is a documented Low, compensated by the loopback filter on every registry-derived base.
