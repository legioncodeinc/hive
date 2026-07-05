/**
 * The CLI verb runners, extracted from cli.ts so they are importable and injectable under test
 * (cli.ts executes on import; this module does not). Each runner returns the process exit code the
 * dispatcher assigns to `process.exitCode`.
 *
 * Lifecycle telemetry firing points (all funnel through src/telemetry/emit.ts, all fail-soft):
 *   - `hive_installed`   after a successful `install-service` (deduped once per machine).
 *   - `hive_uninstalled` on `uninstall-service`, initiated BEFORE teardown, fire-and-forget.
 *   - `hive_first_run`   after the first successful `start` (deduped once per machine).
 *   - `hive_updated`     on `start` when the persisted last-seen version differs (deduped per
 *                           version), which captures npm-reinstall upgrades without an updater.
 * A telemetry failure NEVER changes a verb's exit code: emit helpers resolve, never reject.
 */

import { startHive, type StartHiveOptions } from "./daemon/server.js";
import {
  deleteHiveFromDoctor,
  registerHiveWithDoctor,
  registryContainsHiveEntry,
  type RegistryUpsertOptions
} from "./install/registry.js";
import { hiveStateDirExists, removeHiveStateDir, type StateDirFs } from "./install/state-dir.js";
import { createServiceModule, type ServiceModule } from "./service/index.js";
import { isPidAlive, readPidFile } from "./lock.js";
import { resolveHivePidPath, type FleetRootDeps } from "./shared/apiary-root.js";
import {
  emitInstalled,
  emitUninstalled,
  recordStartLifecycle,
  type EmitDeps
} from "./telemetry/emit.js";

/** A sink for user-facing output lines (defaults to `process.stdout`). */
export type OutputWriter = (text: string) => void;

const defaultOut: OutputWriter = (text) => {
  process.stdout.write(text);
};

/** Injectable deps for the `start` verb. */
export interface StartCommandDeps {
  readonly startOptions?: StartHiveOptions;
  readonly telemetry?: EmitDeps;
  readonly out?: OutputWriter;
}

export async function runStartCommand(deps: StartCommandDeps = {}): Promise<number> {
  const out = deps.out ?? defaultOut;
  const runtime = startHive(deps.startOptions);
  out(`hive listening on http://${runtime.host}:${runtime.port}\n`);

  // The daemon is already listening; record first_run/updated after the user-facing readiness line.
  // recordStartLifecycle never rejects, so a telemetry failure cannot alter the exit code.
  await recordStartLifecycle(deps.telemetry);

  const shutdown = async (signal: string): Promise<void> => {
    out(`received ${signal}, shutting down hive\n`);
    await runtime.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  return 0;
}

/** Injectable deps for the `install-service` / `uninstall-service` verbs. */
export interface ServiceCommandDeps {
  readonly service?: ServiceModule;
  readonly registry?: RegistryUpsertOptions;
  readonly telemetry?: EmitDeps;
  readonly out?: OutputWriter;
}

export async function runInstallServiceCommand(
  cliEntryPath: string,
  deps: ServiceCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  const result = await service.install();
  out(`${result.message}\n`);
  if (!result.ok) return 1;

  const registration = registerHiveWithDoctor(deps.registry);
  out(
    registration.updatedExistingEntry
      ? `Updated existing hive registry entry at ${registration.registryPath}\n`
      : `Registered hive in ${registration.registryPath}\n`
  );

  // Telemetry fires only AFTER the user-facing success; it never rejects and never alters the code.
  await emitInstalled(deps.telemetry);
  return 0;
}

export async function runUninstallServiceCommand(
  cliEntryPath: string,
  deps: ServiceCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });

  // Initiated BEFORE teardown (fire-and-forget) so the event still gets out when teardown removes
  // the install. The promise never rejects; it is awaited after teardown only to let the bounded
  // POST flush before the process exits.
  const uninstallTelemetry = emitUninstalled(deps.telemetry);

  const result = await service.uninstall();
  out(`${result.message}\n`);
  await uninstallTelemetry;
  // M-2 / b-AC-6: the current unit having already been absent is a friendly no-op,
  // not a failure - only a genuine deregister error should flip the exit code.
  return result.ok || result.alreadyAbsent ? 0 : 1;
}

/** Injectable deps for the `register` verb. */
export interface RegisterCommandDeps {
  readonly registry?: RegistryUpsertOptions;
  readonly out?: OutputWriter;
}

export async function runRegisterCommand(deps: RegisterCommandDeps = {}): Promise<number> {
  const out = deps.out ?? defaultOut;
  const registration = registerHiveWithDoctor(deps.registry);
  out(
    registration.updatedExistingEntry
      ? `Updated existing hive registry entry at ${registration.registryPath}\n`
      : `Registered hive in ${registration.registryPath}\n`
  );
  return 0;
}

/** Injectable deps for the `stop` verb. */
export interface StopCommandDeps {
  readonly service?: ServiceModule;
  readonly fleetRoot?: FleetRootDeps;
  readonly pidPath?: string;
  readonly readPid?: (path: string) => number | null;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly out?: OutputWriter;
}

function isHiveProcessRunning(deps: StopCommandDeps): boolean {
  const pidPath = deps.pidPath ?? resolveHivePidPath(deps.fleetRoot);
  const pid = (deps.readPid ?? readPidFile)(pidPath);
  return pid !== null && (deps.isPidAlive ?? isPidAlive)(pid);
}

export async function runStopCommand(cliEntryPath: string, deps: StopCommandDeps = {}): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });

  if (await service.isRegistered()) {
    const result = await service.stop();
    if (!result.ok && !isHiveProcessRunning(deps)) {
      out("hive is not running.\n");
      return 0;
    }
    out(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }

  if (!isHiveProcessRunning(deps)) {
    out("hive is not running.\n");
    return 0;
  }

  const pidPath = deps.pidPath ?? resolveHivePidPath(deps.fleetRoot);
  const pid = (deps.readPid ?? readPidFile)(pidPath);
  if (pid === null) {
    out("hive is not running.\n");
    return 0;
  }

  try {
    (deps.kill ?? ((targetPid, signal) => process.kill(targetPid, signal)))(pid, "SIGTERM");
    out(`Sent SIGTERM to hive (pid ${pid}).\n`);
    return 0;
  } catch (error) {
    out(`Could not stop hive: ${error instanceof Error ? error.message : "unknown error"}.\n`);
    return 1;
  }
}

/** Injectable deps for the `uninstall` verb. */
export interface UninstallCommandDeps extends ServiceCommandDeps {
  readonly fleetRoot?: FleetRootDeps;
  readonly stateDirFs?: StateDirFs;
  readonly stop?: (cliEntryPath: string) => Promise<number>;
}

async function hiveHasInstallArtifacts(
  cliEntryPath: string,
  deps: UninstallCommandDeps
): Promise<boolean> {
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  if (await service.isRegistered()) return true;
  if (registryContainsHiveEntry(deps.registry)) return true;
  if (hiveStateDirExists(deps.fleetRoot, deps.stateDirFs)) return true;
  return false;
}

export async function runUninstallCommand(
  cliEntryPath: string,
  deps: UninstallCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;

  if (!(await hiveHasInstallArtifacts(cliEntryPath, deps))) {
    out("hive is not installed; nothing to remove.\n");
    return 0;
  }

  const stop = deps.stop ?? ((entryPath: string) => runStopCommand(entryPath, deps));
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });

  const uninstallTelemetry = emitUninstalled(deps.telemetry);

  const stopCode = await stop(cliEntryPath);
  out(stopCode === 0 ? "Stopped hive daemon.\n" : "Stop step reported an issue; continuing uninstall.\n");

  const serviceResult = await service.uninstall();
  out(`${serviceResult.message}\n`);

  const registryResult = deleteHiveFromDoctor(deps.registry);
  out(
    registryResult.removed
      ? `Removed hive from doctor registry (${registryResult.registryPaths.join(", ")}).\n`
      : "No hive registry entry to remove.\n"
  );

  let stateRemoved = false;
  try {
    stateRemoved = removeHiveStateDir(deps.fleetRoot, deps.stateDirFs);
  } catch (error) {
    out(
      `Could not remove hive state dir: ${error instanceof Error ? error.message : "unknown error"}.\n`
    );
    await uninstallTelemetry;
    return 1;
  }
  out(stateRemoved ? "Removed hive state dir.\n" : "No hive state dir to remove.\n");

  await uninstallTelemetry;
  // M-2 / b-AC-6: the current unit having already been absent (e.g. the stop step
  // above already boot-ed it out on macOS) is a friendly no-op, not a failure.
  // AC-9: never print the success line on the failure path - a contradictory
  // "hive uninstalled." after a real deregister error hides the failure.
  if (serviceResult.ok || serviceResult.alreadyAbsent) {
    out("hive uninstalled.\n");
    return 0;
  }
  out("hive uninstall completed with errors: the service unit may still be registered. Fix the error above and re-run 'hive uninstall'.\n");
  return 1;
}
