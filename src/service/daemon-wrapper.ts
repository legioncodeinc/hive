import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { resolveServiceLogPaths, type FleetRootDeps } from "../shared/apiary-root.js";

export interface ServiceDaemonDeps {
  readonly fleetRoot?: FleetRootDeps;
  readonly spawnChild?: typeof spawn;
}

function openOwnedLog(path: string): number {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("refusing symlinked service log");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("refusing non-file service log");
  }
  chmodSync(path, 0o600);
  return fd;
}

/**
 * Run the foreground daemon as a fixed-argv child whose output is bound to Hive's owned log files.
 * This gives Windows Task Scheduler the same authoritative logs launchd/systemd expose without a
 * shell or user-controlled interpolation. The wrapper forwards termination signals to the child.
 */
export async function runServiceDaemon(
  cliEntryPath: string,
  deps: ServiceDaemonDeps = {}
): Promise<number> {
  const logs = resolveServiceLogPaths(deps.fleetRoot);
  mkdirSync(dirname(logs.out), { recursive: true, mode: 0o700 });
  let stdoutFd: number;
  let stderrFd: number;
  try {
    stdoutFd = openOwnedLog(logs.out);
    stderrFd = logs.err === logs.out ? stdoutFd : openOwnedLog(logs.err);
  } catch {
    return 1;
  }

  let child: ChildProcess;
  try {
    child = (deps.spawnChild ?? spawn)(process.execPath, [cliEntryPath, "daemon"], {
      env: process.env,
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true
    });
  } catch {
    closeSync(stdoutFd);
    if (stderrFd !== stdoutFd) closeSync(stderrFd);
    return 1;
  }

  return await new Promise<number>((resolve) => {
    let settled = false;
    let terminationRequested = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      closeSync(stdoutFd);
      if (stderrFd !== stdoutFd) closeSync(stderrFd);
      resolve(code);
    };
    const forward = (signal: NodeJS.Signals): void => {
      terminationRequested = true;
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? (terminationRequested ? 0 : 1)));
  });
}
