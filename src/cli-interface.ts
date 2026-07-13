import {
  composeProductManifest,
  confirm,
  exitCodeFor,
  formatStatus,
  formatTelemetrySummary,
  REFERENCE_PRODUCT_BRANDS,
  renderProductBanner,
  renderVersion,
  renderVersionJson,
  resolveCommand,
  statusToJson,
  telemetrySummaryToJson,
  type CommandResult,
  type ProductManifest
} from "@legioncodeinc/cli-kit";

import {
  runDaemonCommand,
  runInstallCommand,
  runInstallServiceCommand,
  runRegisterCommand,
  runRestartCommand,
  runStartCommand,
  runStopCommand,
  runUninstallCommand,
  runUninstallServiceCommand,
  type OutputWriter
} from "./cli-commands.js";
import {
  inspectHiveStatus,
  inspectHiveTelemetry,
  runLogsCommand,
  type LogsDeps,
  type StatusDeps,
  type TelemetryDeps
} from "./cli-observability.js";
import { runUpdateCommand } from "./cli-update.js";
import { HIVE_VERSION } from "./shared/constants.js";
import { sanitizeTerminalText } from "./terminal-safety.js";

export const HIVE_MANIFEST: ProductManifest = composeProductManifest("hive", [
  {
    name: "daemon",
    summary: "Run the Hive daemon in the foreground",
    destructive: false,
    idempotent: false,
    json: true
  }
]);

export function renderHiveHelp(width = 80): string {
  return `${renderProductBanner({
    brand: REFERENCE_PRODUCT_BRANDS.hive,
    version: HIVE_VERSION,
    manifest: HIVE_MANIFEST,
    width
  })}\n`;
}

export type HiveCommandExecutor = (
  command: string,
  args: readonly string[],
  cliEntryPath: string,
  out: OutputWriter
) => Promise<number>;

export interface HiveCliDeps {
  readonly stdout?: OutputWriter;
  readonly stderr?: OutputWriter;
  readonly width?: number;
  readonly execute?: HiveCommandExecutor;
  readonly status?: StatusDeps;
  readonly telemetry?: TelemetryDeps;
  readonly logs?: LogsDeps;
  readonly confirmRemoval?: (assumeYes: boolean) => Promise<boolean>;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function result(command: string, ok: boolean, message: string, details?: Record<string, unknown>): CommandResult<Record<string, unknown>> {
  return details === undefined
    ? { product: "hive", command, ok, message }
    : { product: "hive", command, ok, message, details };
}

async function executeHiveCommand(
  command: string,
  args: readonly string[],
  cliEntryPath: string,
  out: OutputWriter
): Promise<number> {
  switch (command) {
    case "start": return runStartCommand(cliEntryPath, { out });
    case "stop": return runStopCommand(cliEntryPath, { out });
    case "restart": return runRestartCommand(cliEntryPath, { out });
    case "install": return runInstallCommand(cliEntryPath, { out });
    case "uninstall": return runUninstallCommand(cliEntryPath, { out });
    case "service-install": return runInstallServiceCommand(cliEntryPath, { out });
    case "service-uninstall": return runUninstallServiceCommand(cliEntryPath, { out });
    case "update": return runUpdateCommand(cliEntryPath, { out });
    case "register": return runRegisterCommand({ out });
    case "daemon": return runDaemonCommand({ out });
    default:
      out(`No Hive handler is registered for ${command}.\n`);
      return 1;
  }
}

export async function runHiveCli(
  argv: readonly string[],
  cliEntryPath: string,
  deps: HiveCliDeps = {}
): Promise<number> {
  const rawStdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const rawStderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const json = argv.includes("--json");
  const stdout: OutputWriter = json ? rawStdout : (text) => rawStdout(sanitizeTerminalText(text));
  const stderr: OutputWriter = json ? rawStderr : (text) => rawStderr(sanitizeTerminalText(text));
  const withoutGlobals = argv.filter((arg) => arg !== "--json" && arg !== "--no-color");

  if (withoutGlobals.length === 0 || withoutGlobals.includes("--help") || withoutGlobals.includes("-h")) {
    if (json) {
      stdout(jsonLine(result("help", true, "Hive command help", {
        commands: HIVE_MANIFEST.commands.map(({ name, group, summary }) => ({ name, group, summary }))
      })));
    } else {
      stdout(renderHiveHelp(deps.width ?? process.stdout.columns ?? 80));
    }
    return 0;
  }

  if (withoutGlobals[0] === "--version") {
    stdout(json ? renderVersionJson("hive", HIVE_VERSION) : renderVersion("hive", HIVE_VERSION));
    return 0;
  }

  const input = withoutGlobals[0] ?? "";
  const resolution = resolveCommand(HIVE_MANIFEST, input);
  if (!resolution.ok) {
    if (json) stdout(jsonLine(result(input, false, resolution.message)));
    else stderr(`${resolution.message}\n`);
    return exitCodeFor("usage-error");
  }

  const command = resolution.canonicalName;
  const commandArgs = withoutGlobals.slice(1);
  if (json && !resolution.command.json) {
    const message = `${command} does not support --json.`;
    stdout(jsonLine(result(command, false, message)));
    return exitCodeFor("usage-error");
  }
  if (resolution.deprecatedAlias !== undefined && !json) {
    stderr(`Warning: '${resolution.deprecatedAlias}' is deprecated; use '${command}'.\n`);
  }

  if (command === "uninstall") {
    const invalidArgs = commandArgs.filter((arg) => arg !== "--yes");
    if (invalidArgs.length > 0 || commandArgs.filter((arg) => arg === "--yes").length > 1) {
      const message = "uninstall accepts only the --yes confirmation flag.";
      if (json) stdout(jsonLine(result(command, false, message)));
      else stderr(`${message}\n`);
      return exitCodeFor("usage-error");
    }
    const assumeYes = commandArgs.includes("--yes");
    if (json && !assumeYes) {
      stdout(jsonLine(result(command, false, "uninstall --json requires --yes.")));
      return exitCodeFor("usage-error");
    }
    let accepted: boolean;
    try {
      accepted = await (deps.confirmRemoval ?? ((yes) => confirm(
        "Remove the Hive service, Doctor registration, and Hive-owned state?",
        { assumeYes: yes, default: false }
      )))(assumeYes);
    } catch (error) {
      const message = error instanceof Error ? error.message : "uninstall confirmation failed";
      if (json) stdout(jsonLine(result(command, false, message)));
      else stderr(`${message}\n`);
      return exitCodeFor("runtime-error");
    }
    if (!accepted) {
      const message = "Hive uninstall cancelled; no changes were made.";
      if (json) stdout(jsonLine(result(command, true, message)));
      else stdout(`${message}\n`);
      return 0;
    }
  }

  if (command === "status") {
    if (commandArgs.length > 0) {
      const message = "status does not accept positional arguments.";
      if (json) stdout(jsonLine(result(command, false, message)));
      else stderr(`${message}\n`);
      return exitCodeFor("usage-error");
    }
    try {
      const status = await inspectHiveStatus(cliEntryPath, deps.status);
      if (json) stdout(jsonLine(result(command, true, "Hive status", { status: statusToJson(status) })));
      else stdout(formatStatus(status));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Hive status failed";
      if (json) stdout(jsonLine(result(command, false, message)));
      else stderr(`${message}\n`);
      return exitCodeFor("runtime-error");
    }
  }

  if (command === "telemetry") {
    if (commandArgs.length > 0) {
      const message = "telemetry is read-only and does not accept arguments.";
      if (json) stdout(jsonLine(result(command, false, message)));
      else stderr(`${message}\n`);
      return exitCodeFor("usage-error");
    }
    try {
      const telemetry = inspectHiveTelemetry(deps.telemetry);
      if (json) stdout(jsonLine(result(command, true, "Hive telemetry status", { telemetry: telemetrySummaryToJson(telemetry) })));
      else stdout(formatTelemetrySummary(telemetry));
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Hive telemetry status failed";
      if (json) stdout(jsonLine(result(command, false, message)));
      else stderr(`${message}\n`);
      return exitCodeFor("runtime-error");
    }
  }

  if (command !== "logs" && command !== "uninstall" && commandArgs.length > 0) {
    const message = `${command} does not accept positional arguments.`;
    if (json) stdout(jsonLine(result(command, false, message)));
    else stderr(`${message}\n`);
    return exitCodeFor("usage-error");
  }

  const captured: string[] = [];
  const capturedErrors: string[] = [];
  const streamsOutput = !json && (command === "daemon" || command === "logs");
  const commandOut: OutputWriter = streamsOutput ? stdout : (text) => captured.push(text);
  const commandErr: OutputWriter = json ? (text) => capturedErrors.push(text) : stderr;
  let code: number;
  try {
    if (command === "logs") {
      const logArgs = json && !commandArgs.includes("--no-follow")
        ? [...commandArgs, "--no-follow"]
        : commandArgs;
      code = await runLogsCommand(logArgs, { ...deps.logs, out: commandOut, err: commandErr });
    } else {
      const handlerArgs = command === "uninstall" ? [] : commandArgs;
      code = await (deps.execute ?? executeHiveCommand)(command, handlerArgs, cliEntryPath, commandOut);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Hive runtime error";
    if (json) stdout(jsonLine(result(command, false, message)));
    else stderr(`${message}\n`);
    return exitCodeFor("runtime-error");
  }

  if (json) {
    const message = [...captured, ...capturedErrors].join("").trim() || (code === 0 ? `${command} completed.` : `${command} failed.`);
    const details = command === "logs" ? { lines: captured.join("").split(/\r?\n/).filter(Boolean) } : undefined;
    stdout(jsonLine(result(command, code === 0, message, details)));
  } else if (!streamsOutput) {
    const output = captured.join("");
    (code === 0 ? stdout : stderr)(output);
  }
  return code;
}
