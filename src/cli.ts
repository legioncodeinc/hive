#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runHiveCli } from "./cli-interface.js";
import { DaemonAlreadyRunningError } from "./errors.js";
import { runServiceDaemon } from "./service/daemon-wrapper.js";

async function run(): Promise<void> {
  const cliEntryPath = fileURLToPath(import.meta.url);

  try {
    if (process.argv[2] === "service-daemon") {
      process.exitCode = await runServiceDaemon(cliEntryPath);
      return;
    }
    process.exitCode = await runHiveCli(process.argv.slice(2), cliEntryPath);
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
