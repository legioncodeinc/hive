#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { DaemonAlreadyRunningError } from "./errors.js";
import { startThehive } from "./daemon/server.js";
import { registerThehiveWithHivedoctor } from "./install/registry.js";
import { createServiceModule } from "./service/index.js";

function printUsage(): void {
  process.stderr.write("Usage: thehive <start|install-service|uninstall-service|register>\n");
}

async function runStartCommand(): Promise<number> {
  const runtime = startThehive();
  process.stdout.write(`thehive listening on http://${runtime.host}:${runtime.port}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`received ${signal}, shutting down thehive\n`);
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

async function runInstallServiceCommand(cliEntryPath: string): Promise<number> {
  const service = createServiceModule({ execPath: cliEntryPath });
  const result = await service.install();
  process.stdout.write(`${result.message}\n`);
  if (!result.ok) return 1;

  const registration = registerThehiveWithHivedoctor();
  process.stdout.write(
    registration.updatedExistingEntry
      ? `Updated existing thehive registry entry at ${registration.registryPath}\n`
      : `Registered thehive in ${registration.registryPath}\n`
  );
  return 0;
}

async function runUninstallServiceCommand(cliEntryPath: string): Promise<number> {
  const service = createServiceModule({ execPath: cliEntryPath });
  const result = await service.uninstall();
  process.stdout.write(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

async function runRegisterCommand(): Promise<number> {
  const registration = registerThehiveWithHivedoctor();
  process.stdout.write(
    registration.updatedExistingEntry
      ? `Updated existing thehive registry entry at ${registration.registryPath}\n`
      : `Registered thehive in ${registration.registryPath}\n`
  );
  return 0;
}

async function run(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const cliEntryPath = fileURLToPath(import.meta.url);

  try {
    switch (command) {
      case "start":
        process.exitCode = await runStartCommand();
        return;
      case "install-service":
        process.exitCode = await runInstallServiceCommand(cliEntryPath);
        return;
      case "uninstall-service":
        process.exitCode = await runUninstallServiceCommand(cliEntryPath);
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
