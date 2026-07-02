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
import { registerHiveWithDoctor, type RegistryUpsertOptions } from "./install/registry.js";
import { createServiceModule, type ServiceModule } from "./service/index.js";
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
  return result.ok ? 0 : 1;
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
