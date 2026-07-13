import { promises as fsPromises, watch as watchFile } from "node:fs";

import {
  formatStatus,
  formatTelemetrySummary,
  parseLogTailOptions,
  statusToJson,
  tailProductLog,
  telemetrySummaryToJson,
  type LogFileSystem,
  type ServiceStatus,
  type TelemetrySummary
} from "@legioncodeinc/cli-kit";

import { registryContainsHiveEntry, HIVE_REGISTRY_HEALTH_URL, type RegistryUpsertOptions } from "./install/registry.js";
import { isPidAlive, readPidFile } from "./lock.js";
import { createServiceModule, type ServiceModule } from "./service/index.js";
import {
  resolveHivePidPath,
  resolveHiveStateDir,
  resolveServiceLogPaths,
  type FleetRootDeps
} from "./shared/apiary-root.js";
import { HIVE_VERSION } from "./shared/constants.js";
import { ENV_DO_NOT_TRACK, ENV_TELEMETRY, isOptedOut, loadLedger, POSTHOG_KEY } from "./telemetry/emit.js";
import type { HealthFetch, OutputWriter } from "./cli-commands.js";

export interface StatusDeps {
  readonly service?: ServiceModule;
  readonly fleetRoot?: FleetRootDeps;
  readonly registry?: RegistryUpsertOptions;
  readonly readPid?: (path: string) => number | null;
  readonly pidAlive?: (pid: number) => boolean;
  readonly healthFetch?: HealthFetch;
  readonly healthUrl?: string;
}

export async function inspectHiveStatus(cliEntryPath: string, deps: StatusDeps = {}): Promise<ServiceStatus> {
  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  const pid = (deps.readPid ?? readPidFile)(resolveHivePidPath(deps.fleetRoot));
  const running = pid !== null && (deps.pidAlive ?? isPidAlive)(pid);
  const healthUrl = deps.healthUrl ?? HIVE_REGISTRY_HEALTH_URL;
  let health: ServiceStatus["health"] = { state: running ? "unknown" : "not-applicable", endpoint: healthUrl };
  if (running) {
    try {
      const response = await (deps.healthFetch ?? ((input, init) => fetch(input, init)))(healthUrl, {
        signal: AbortSignal.timeout(1_000)
      });
      health = {
        state: response.ok ? "healthy" : "unhealthy",
        endpoint: healthUrl,
        result: `HTTP ${response.status}`
      };
    } catch (error) {
      health = {
        state: "unhealthy",
        endpoint: healthUrl,
        result: error instanceof Error ? error.message : "request failed"
      };
    }
  }
  const logs = resolveServiceLogPaths(deps.fleetRoot);
  return {
    product: "hive",
    version: HIVE_VERSION,
    installation: (await service.isRegistered()) ? "installed" : "not-installed",
    process: pid === null ? { state: "stopped" } : { state: running ? "running" : "stopped", pid },
    health,
    registration: registryContainsHiveEntry(deps.registry) ? "registered" : "unregistered",
    paths: { config: resolveHiveStateDir(deps.fleetRoot), logs: logs.out }
  };
}

export async function runStatusCommand(
  cliEntryPath: string,
  json: boolean,
  out: OutputWriter,
  deps: StatusDeps = {}
): Promise<number> {
  const status = await inspectHiveStatus(cliEntryPath, deps);
  out(json ? `${JSON.stringify(statusToJson(status))}\n` : formatStatus(status));
  return 0;
}

export interface TelemetryDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fleetRoot?: FleetRootDeps;
  readonly posthogKey?: string;
}

export function inspectHiveTelemetry(deps: TelemetryDeps = {}): TelemetrySummary {
  const env = deps.env ?? process.env;
  const optedOut = isOptedOut(env);
  const controllingSetting =
    env[ENV_TELEMETRY] === "0"
      ? `${ENV_TELEMETRY}=0`
      : env[ENV_DO_NOT_TRACK] !== undefined && env[ENV_DO_NOT_TRACK] !== "" && env[ENV_DO_NOT_TRACK] !== "0"
        ? ENV_DO_NOT_TRACK
        : "default";
  const ledger = loadLedger(resolveHiveStateDir(deps.fleetRoot));
  const sends = Object.values(ledger.reported).sort();
  return {
    state: optedOut ? "opted-out" : "enabled",
    controllingSetting,
    destination: optedOut ? "disabled" : (deps.posthogKey ?? POSTHOG_KEY) === "" ? "disabled" : "hosted",
    lastSuccessfulSend: sends.at(-1),
    optOutInstruction: `Set ${ENV_TELEMETRY}=0 or ${ENV_DO_NOT_TRACK}=1.`
  };
}

export function runTelemetryCommand(
  json: boolean,
  out: OutputWriter,
  deps: TelemetryDeps = {}
): number {
  const summary = inspectHiveTelemetry(deps);
  out(json ? `${JSON.stringify(telemetrySummaryToJson(summary))}\n` : formatTelemetrySummary(summary));
  return 0;
}

function createNodeLogFs(): LogFileSystem {
  return {
    readFile: (path) => fsPromises.readFile(path, "utf8"),
    realpath: (path) => fsPromises.realpath(path),
    watch(path, onChange) {
      const watcher = watchFile(path, () => onChange());
      return { close: () => watcher.close() };
    }
  };
}

export interface LogsDeps {
  readonly fleetRoot?: FleetRootDeps;
  readonly fs?: LogFileSystem;
  readonly signal?: AbortSignal;
  readonly out?: OutputWriter;
  readonly err?: OutputWriter;
}

export async function runLogsCommand(argv: readonly string[], deps: LogsDeps = {}): Promise<number> {
  const parsed = parseLogTailOptions(argv);
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? out;
  if (!parsed.ok) {
    err(`${parsed.error}\n`);
    return 2;
  }
  const logPath = resolveServiceLogPaths(deps.fleetRoot).out;
  const controller = deps.signal === undefined ? new AbortController() : undefined;
  const onSigint = (): void => controller?.abort();
  if (controller !== undefined) process.once("SIGINT", onSigint);
  const result = await tailProductLog({
    productId: "hive",
    serviceId: "com.legioncode.hive",
    source: { productId: "hive", serviceId: "com.legioncode.hive", root: resolveHiveStateDir(deps.fleetRoot), path: logPath },
    options: parsed.options,
    fs: deps.fs ?? createNodeLogFs(),
    write: out,
    signal: deps.signal ?? controller?.signal
  }).finally(() => {
    if (controller !== undefined) process.off("SIGINT", onSigint);
  });
  if (!result.ok) {
    err(`${result.error}\n`);
    return 1;
  }
  return 0;
}
