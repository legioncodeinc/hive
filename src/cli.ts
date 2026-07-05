#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  runInstallServiceCommand,
  runRegisterCommand,
  runStartCommand,
  runStopCommand,
  runUninstallCommand,
  runUninstallServiceCommand
} from "./cli-commands.js";
import { DaemonAlreadyRunningError } from "./errors.js";

function printUsage(): void {
  process.stderr.write("Usage: hive <start|stop|install-service|uninstall-service|uninstall|register>\n");
}

async function run(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const cliEntryPath = fileURLToPath(import.meta.url);

  try {
    switch (command) {
      case "start":
        process.exitCode = await runStartCommand();
        return;
      case "stop":
        process.exitCode = await runStopCommand(cliEntryPath);
        return;
      case "install-service":
        process.exitCode = await runInstallServiceCommand(cliEntryPath);
        return;
      case "uninstall-service":
        process.exitCode = await runUninstallServiceCommand(cliEntryPath);
        return;
      case "uninstall":
        process.exitCode = await runUninstallCommand(cliEntryPath);
        return;
      case "register":
        process.exitCode = await runRegisterCommand();
        return;
      default:
        printUsage();
        process.exitCode = 1;
        return;
    }
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void run();
