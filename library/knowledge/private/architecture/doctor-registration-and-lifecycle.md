# Doctor Registration And Lifecycle

> Category: Architecture | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

Read this if you operate hive or touch `src/lock.ts`, `src/install/registry.ts`, or `src/service/`: it covers the single-instance guard, the OS service units, registration with doctor, and what uninstall does and honestly does not do.

**Related:**
- [system-overview.md](./system-overview.md)
- [../infrastructure/build-and-release.md](../infrastructure/build-and-release.md)
- [../security/trust-boundaries.md](../security/trust-boundaries.md)
- [../../../requirements/in-work/prd-001-hive-portal-daemon/prd-001d-service-unit-and-registration.md](../../../requirements/in-work/prd-001-hive-portal-daemon/prd-001d-service-unit-and-registration.md)
- [ADR-0001](./ADR-0001-retire-honeycomb-dashboard-and-copy-and-own-into-hive.md)
---

## The CLI surface

Four verbs, dispatched in `src/cli.ts`, implemented in `src/cli-commands.ts`:

```
hive start                # run the daemon on 127.0.0.1:3853 (the default verb)
hive install-service      # write + start the OS unit, then register with doctor
hive uninstall-service    # deregister + remove the OS unit (registry entry stays; see below)
hive register             # upsert hive's entry into doctor's registry, standalone
```

Each verb also fires one fail-soft lifecycle telemetry event through `src/telemetry/emit.ts` (`hive_installed`, `hive_uninstalled`, `hive_first_run`, `hive_updated`); a telemetry failure never changes a verb's exit code. See [../infrastructure/build-and-release.md](../infrastructure/build-and-release.md) for the chokepoint details.

## Single-instance guard

`startHive` acquires the lock before the socket, in `acquireSingleInstanceLock` (`src/lock.ts`):

1. Open `~/.honeycomb/hive.lock` with the `wx` flag (exclusive create). Success means we own the instance; write our PID into the lock file and mirror it to `~/.honeycomb/hive.pid`.
2. On `EEXIST`, read the PID out of the existing lock and probe it with `process.kill(pid, 0)`. A live process (including `EPERM`, which means "alive but not ours") throws `DaemonAlreadyRunningError`, and the second `hive start` exits 1 with `hive is already running (pid N) and holds lock ...`.
3. A dead PID means a stale lock (crash, power loss): remove it and retry the exclusive create exactly once. Losing that race to another starter also throws `DaemonAlreadyRunningError`.

`stop()` (and signal handlers for SIGINT/SIGTERM) closes the server and releases both files. The lock is PID-probe based, not flock-based, which is what lets a crashed daemon's lock be reclaimed without manual cleanup. `tests/lock.test.ts` covers acquisition, stale reclaim, and the race.

The `pidPath` in doctor's registry entry points at the same `hive.pid`, so the supervisor and the lock agree on which process is "the" hive.

## OS service unit

`hive install-service` resolves a per-platform plan (`src/service/platform.ts`), renders the unit (`src/service/templates.ts`), writes it, and runs the manager commands (`src/service/commands.ts`) through `execFile` (argv arrays, no shell, 15 s timeout per command).

| Platform | Manager | Unit name | Unit path |
|---|---|---|---|
| macOS | launchd (user domain `gui/<uid>`) | `com.legioncode.hive` | `~/Library/LaunchAgents/com.legioncode.hive.plist` |
| Linux | systemd (user) | `hive.service` | `~/.config/systemd/user/hive.service` |
| Windows | schtasks | task `hive` | XML staged at `~/.honeycomb/hive/hive-task.xml` |

All three units run `node <cli.js> start` and encode restart-on-crash plus start-on-boot/login: launchd sets `RunAtLoad` + `KeepAlive` with a 5 s `ThrottleInterval` (stdout/stderr to `~/.honeycomb/hive/launchd.*.log`); systemd sets `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0`, `WantedBy=default.target`; the Windows task uses a `LogonTrigger`, `RestartOnFailure` every `PT1M` up to 999 times, and `MultipleInstancesPolicy: IgnoreNew` (the OS-level echo of the PID lock).

**Legacy migration (decision #32).** Hive shipped briefly under the name `thehive` (`thehive` launchd label, `thehive.service`, Windows task `thehive`). Every install now begins by best-effort deregistering those legacy units and deleting their unit files (`legacyUninstallCommands`, `legacyUnitPath`), so a re-run migrates an old install instead of leaving two units racing over one daemon. When no legacy unit exists the commands fail harmlessly and the install proceeds.

## Idempotent doctor registration

After the unit is installed (or standalone via `hive register`), `registerHiveWithDoctor` (`src/install/registry.ts`) upserts hive's entry into `~/.honeycomb/doctor.daemons.json`:

```typescript
export function buildHiveRegistryEntry(): RegistryDaemonEntry {
  return {
    name: HIVE_REGISTRY_NAME,                       // "hive"
    healthUrl: HIVE_REGISTRY_HEALTH_URL,            // "http://127.0.0.1:3853/health"
    pidPath: HIVE_REGISTRY_PID_PATH,                // "~/.honeycomb/hive.pid"
    probeIntervalMs: HIVE_REGISTRY_PROBE_INTERVAL_MS,          // 30_000
    startupGraceMs: HIVE_REGISTRY_STARTUP_GRACE_MS,            // 60_000
    restartGiveUpThreshold: HIVE_REGISTRY_RESTART_GIVE_UP_THRESHOLD, // 3
    restartCooldownMs: HIVE_REGISTRY_RESTART_COOLDOWN_MS       // 5_000
  };
}
```

The write is read-modify-write with real idempotence: an existing `name: "hive"` entry is merged in place (`{ ...existing, ...hiveEntry }`, preserving any extra keys doctor added), a missing one is appended, and every other daemon's entry is left byte-for-byte alone. The file is written atomically: serialize to `doctor.daemons.json.tmp-<pid>-<ts>`, then `rename` over the original, with the temp file removed on a failed rename. A corrupt or missing registry parses to an empty document rather than an error, so registration works on a box where doctor has never run. No doctor restart is required; doctor picks the entry up from the file. `tests/install/registry.test.ts` pins the upsert, the merge, and the atomicity.

## Uninstall: what it does and does not do

`hive uninstall-service` runs the manager's deregister command (`launchctl bootout` / `systemctl --user disable --now` / `schtasks /Delete`) and removes the unit file. The daemon stops and will not start on next boot.

**It does NOT deregister hive from doctor's registry.** There is no registry-removal code anywhere in the package; `runUninstallServiceCommand` touches only the service module. After an uninstall, doctor still carries hive's entry, still probes `http://127.0.0.1:3853/health` every 30 seconds, and will report hive as unreachable (and, depending on doctor's remediation config, may try to restart a process that no longer has a unit). If you want doctor to forget hive, edit `~/.honeycomb/doctor.daemons.json` by hand today. This asymmetry is a known, honest gap, not a documented feature.

## Boot order and lifecycle

Hive is deliberately not gated on any peer at boot. The OS starts doctor and hive independently; hive binds and serves its shell immediately, and whatever the fleet looks like is rendered honestly by the landing gate (`/buzzing` while doctor or honeycomb are still coming up). Doctor's `startupGraceMs: 60_000` gives hive a minute after boot before missed probes count against the restart threshold (3 strikes, 5 s cooldown between restarts).

```mermaid
sequenceDiagram
    participant OS as OS service manager
    participant D as doctor :3852
    participant H as hive :3853
    participant B as Browser

    OS->>D: start (own unit)
    OS->>H: start (com.legioncode.hive / hive.service / task "hive")
    H->>H: acquire ~/.honeycomb/hive.lock, write hive.pid
    H->>H: bind 127.0.0.1:3853, serve shell
    D->>H: GET /health every 30s (registry entry)
    B->>H: GET / (gate: fleet not ready yet)
    H-->>B: 302 /buzzing
    Note over D,H: workloads come up; doctor reports fleet ok
    B->>H: GET /buzzing poll observes ready, hard-navigates /
    H-->>B: dashboard
```

There is no ordering dependency between hive and the workload daemons at all: the gate and the fail-soft proxy absorb every combination of who is up first.
