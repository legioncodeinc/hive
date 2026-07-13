/**
 * The CLI verb runners, extracted from cli.ts so they are importable and injectable under test
 * (cli.ts executes on import; this module does not). Each runner returns the process exit code the
 * dispatcher assigns to `process.exitCode`.
 *
 * Lifecycle telemetry firing points (all funnel through src/telemetry/emit.ts, all fail-soft):
 *   - `hive_installed`   after a successful full `install` (deduped once per machine).
 *   - `hive_uninstalled` on full `uninstall`, initiated BEFORE teardown, fire-and-forget.
 *   - `hive_first_run`   after the first successful foreground `daemon` start (deduped once per machine).
 *   - `hive_updated`     on `daemon` when the persisted last-seen version differs (deduped per
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
import { isHiveCliProcess } from "./process-identity.js";
import { resolveHivePidPath, type FleetRootDeps } from "./shared/apiary-root.js";
import {
  emitInstalled,
  emitUninstalled,
  recordStartLifecycle,
  type EmitDeps
} from "./telemetry/emit.js";
import { HIVE_REGISTRY_HEALTH_URL } from "./install/registry.js";

/** A sink for user-facing output lines (defaults to `process.stdout`). */
export type OutputWriter = (text: string) => void;

const defaultOut: OutputWriter = (text) => {
  process.stdout.write(text);
};

/** Injectable deps for the product-specific foreground `daemon` verb. */
export interface DaemonCommandDeps {
  readonly startOptions?: StartHiveOptions;
  readonly telemetry?: EmitDeps;
  readonly out?: OutputWriter;
}

export async function runDaemonCommand(deps: DaemonCommandDeps = {}): Promise<number> {
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

/** Injectable deps for service installation/removal and the full install transaction. */
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
  if (await service.isRegistered()) {
    const stopCode = await runStopCommand(cliEntryPath, { service, out });
    if (stopCode !== 0) return stopCode;
  }
  const result = await service.install();
  out(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

export async function runUninstallServiceCommand(
  cliEntryPath: string,
  deps: ServiceCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });

  const result = await service.uninstall();
  out(`${result.message}\n`);
  // M-2 / b-AC-6: the current unit having already been absent is a friendly no-op,
  // not a failure - only a genuine deregister error should flip the exit code.
  return result.ok || result.alreadyAbsent ? 0 : 1;
}

/** Full onboarding transaction: reconcile the OS service, register with Doctor, then report install. */
export async function runInstallCommand(
  cliEntryPath: string,
  deps: ServiceCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  if (await service.isRegistered()) {
    const stopCode = await runStopCommand(cliEntryPath, { service, out });
    if (stopCode !== 0) return stopCode;
  }
  const serviceResult = await service.install();
  out(`${serviceResult.message}\n`);
  if (!serviceResult.ok) return 1;

  const registration = registerHiveWithDoctor(deps.registry);
  out(
    registration.updatedExistingEntry
      ? `Updated existing hive registry entry at ${registration.registryPath}\n`
      : `Registered hive in ${registration.registryPath}\n`
  );
  await emitInstalled(deps.telemetry);
  return 0;
}

/** Start only the already-installed OS service; foreground execution belongs to `hive daemon`. */
export async function runStartCommand(
  cliEntryPath: string,
  deps: ServiceCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  const result = await service.start();
  out(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

export type HealthFetch = (
  input: string,
  init?: { readonly signal?: AbortSignal }
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export interface RestartCommandDeps extends StopCommandDeps {
  readonly healthFetch?: HealthFetch;
  readonly healthUrl?: string;
  readonly healthAttempts?: number;
  readonly healthDelayMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export async function waitForHiveHealth(deps: RestartCommandDeps): Promise<boolean> {
  const fetchHealth = deps.healthFetch ?? ((input, init) => fetch(input, init));
  const attempts = Math.min(60, Math.max(1, Math.floor(deps.healthAttempts ?? 10)));
  const delayMs = Math.min(5_000, Math.max(0, Math.floor(deps.healthDelayMs ?? 250)));
  const delay = deps.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchHealth(deps.healthUrl ?? HIVE_REGISTRY_HEALTH_URL, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) return true;
    } catch {
      // A bounded retry handles the service's normal boot window.
    }
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  return false;
}

/** Stop, start, and prove health before reporting success. */
export async function runRestartCommand(
  cliEntryPath: string,
  deps: RestartCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  if (!(await service.isRegistered())) {
    out("hive service is not installed; run 'hive service-install' first.\n");
    return 1;
  }

  const stopCode = await runStopCommand(cliEntryPath, { ...deps, service, out });
  if (stopCode !== 0) return stopCode;
  const started = await service.start();
  out(`${started.message}\n`);
  if (!started.ok) return 1;
  if (!(await waitForHiveHealth(deps))) {
    out("hive service restarted but did not become healthy before the timeout.\n");
    return 1;
  }
  out("hive service restarted and is healthy.\n");
  return 0;
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
  readonly isOwnedHiveProcess?: (pid: number, cliEntryPath: string) => Promise<boolean>;
  readonly stopAttempts?: number;
  readonly stopDelayMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly out?: OutputWriter;
}

function isHiveProcessRunning(deps: StopCommandDeps): boolean {
  const pidPath = deps.pidPath ?? resolveHivePidPath(deps.fleetRoot);
  const pid = (deps.readPid ?? readPidFile)(pidPath);
  return pid !== null && (deps.isPidAlive ?? isPidAlive)(pid);
}

async function terminateHiveProcess(
  cliEntryPath: string,
  deps: StopCommandDeps,
  out: OutputWriter,
  previouslyVerifiedPid?: number | null
): Promise<boolean> {
  const pidPath = deps.pidPath ?? resolveHivePidPath(deps.fleetRoot);
  const pid = (deps.readPid ?? readPidFile)(pidPath);
  const pidIsAlive = deps.isPidAlive ?? isPidAlive;
  if (pid === null || !pidIsAlive(pid)) return true;

  const identityVerified = (previouslyVerifiedPid === undefined || previouslyVerifiedPid === pid) &&
    await (deps.isOwnedHiveProcess ?? isHiveCliProcess)(pid, cliEntryPath);
  if (!identityVerified) {
    out(`Could not stop hive: pid ${pid} does not identify the expected hive daemon.\n`);
    return false;
  }

  try {
    (deps.kill ?? ((targetPid, signal) => process.kill(targetPid, signal)))(pid, "SIGTERM");
    out(`Sent SIGTERM to hive (pid ${pid}).\n`);
  } catch (error) {
    out(`Could not stop hive: ${error instanceof Error ? error.message : "unknown error"}.\n`);
    return false;
  }

  const attempts = Math.min(100, Math.max(1, Math.floor(deps.stopAttempts ?? 40)));
  const delayMs = Math.min(1_000, Math.max(0, Math.floor(deps.stopDelayMs ?? 50)));
  const delay = deps.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!pidIsAlive(pid)) return true;
    if (attempt + 1 < attempts) await delay(delayMs);
  }

  out(`Could not stop hive: pid ${pid} remained running after SIGTERM.\n`);
  return false;
}

export async function runStopCommand(cliEntryPath: string, deps: StopCommandDeps = {}): Promise<number> {
  const out = deps.out ?? defaultOut;
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });

  if (await service.isRegistered()) {
    const pidPath = deps.pidPath ?? resolveHivePidPath(deps.fleetRoot);
    const candidatePid = (deps.readPid ?? readPidFile)(pidPath);
    const candidateIsAlive = candidatePid !== null && (deps.isPidAlive ?? isPidAlive)(candidatePid);
    const verifiedPid = candidateIsAlive && candidatePid !== null &&
      await (deps.isOwnedHiveProcess ?? isHiveCliProcess)(candidatePid, cliEntryPath)
      ? candidatePid
      : null;
    const result = await service.stop();
    if (!result.ok && !isHiveProcessRunning(deps)) {
      out("hive is not running.\n");
      return 0;
    }
    out(`${result.message}\n`);
    if (!result.ok) return 1;
    if (!isHiveProcessRunning(deps)) return 0;
    out("Service manager left the hive daemon running; stopping the owned hive pid.\n");
    return (await terminateHiveProcess(cliEntryPath, deps, out, verifiedPid)) ? 0 : 1;
  }

  if (!isHiveProcessRunning(deps)) {
    out("hive is not running.\n");
    return 0;
  }

  return (await terminateHiveProcess(cliEntryPath, deps, out)) ? 0 : 1;
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
