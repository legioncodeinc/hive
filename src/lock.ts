import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";
import { DaemonAlreadyRunningError } from "./errors.js";
import { HIVE_LOCK_PATH, HIVE_PID_PATH } from "./shared/constants.js";

export interface LockPaths {
  readonly lockFilePath: string;
  readonly pidFilePath: string;
}

export function resolveLockPaths(paths: Partial<LockPaths> = {}): LockPaths {
  return {
    lockFilePath: paths.lockFilePath ?? HIVE_LOCK_PATH,
    pidFilePath: paths.pidFilePath ?? HIVE_PID_PATH
  };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export function readPidFile(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "") return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireSingleInstanceLock(paths: Partial<LockPaths> = {}): LockPaths {
  const resolved = resolveLockPaths(paths);
  mkdirSync(dirname(resolved.lockFilePath), { recursive: true });
  const pid = String(process.pid);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(resolved.lockFilePath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const existingPid = readPidFile(resolved.lockFilePath);
      if (existingPid !== null && isPidAlive(existingPid)) {
        throw new DaemonAlreadyRunningError(existingPid, resolved.lockFilePath);
      }

      rmSync(resolved.lockFilePath, { force: true });
      continue;
    }

    try {
      writeSync(fd, pid);
    } finally {
      closeSync(fd);
    }

    try {
      writeFileSync(resolved.pidFilePath, pid, "utf8");
    } catch (error) {
      rmSync(resolved.lockFilePath, { force: true });
      throw error;
    }

    return resolved;
  }

  const racedPid = readPidFile(resolved.lockFilePath);
  throw new DaemonAlreadyRunningError(racedPid ?? -1, resolved.lockFilePath);
}

export function releaseSingleInstanceLock(paths: Partial<LockPaths> = {}): void {
  const resolved = resolveLockPaths(paths);
  rmSync(resolved.lockFilePath, { force: true });
  rmSync(resolved.pidFilePath, { force: true });
}

export function isLockHeldByLiveDaemon(paths: Partial<LockPaths> = {}): boolean {
  const resolved = resolveLockPaths(paths);
  if (!existsSync(resolved.lockFilePath)) return false;
  const pid = readPidFile(resolved.lockFilePath);
  return pid !== null && isPidAlive(pid);
}
