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
import { type FleetRootDeps } from "./shared/apiary-root.js";
import { HIVE_LOCK_PATH, HIVE_PID_PATH } from "./shared/constants.js";
import { resolveLegacyHiveLockPath, resolveLegacyHivePidPath } from "./shared/legacy-paths.js";

export interface LockPaths {
  readonly lockFilePath: string;
  readonly pidFilePath: string;
}

export interface LockPathOptions extends Partial<LockPaths>, FleetRootDeps {}

export function resolveLockPaths(paths: LockPathOptions = {}): LockPaths {
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

function assertLegacyLockNotHeldByLiveDaemon(deps: FleetRootDeps = {}): void {
  const legacyLockPath = resolveLegacyHiveLockPath(deps);
  if (!existsSync(legacyLockPath)) return;
  const existingPid = readPidFile(legacyLockPath);
  if (existingPid !== null && isPidAlive(existingPid)) {
    throw new DaemonAlreadyRunningError(existingPid, legacyLockPath);
  }
}

/**
 * mg-AC-6: genuinely best-effort. `force: true` suppresses only ENOENT; an EBUSY/EPERM (a file
 * held open on Windows, a permissions oddity in the legacy dir) must never abort the always-on
 * portal's boot, so each removal is individually swallowed. A leftover stale pair is retried on
 * the next boot.
 */
function removeStaleLegacyLockArtifacts(deps: FleetRootDeps = {}): void {
  try {
    rmSync(resolveLegacyHiveLockPath(deps), { force: true });
  } catch {
    // Best-effort cleanup only.
  }
  try {
    rmSync(resolveLegacyHivePidPath(deps), { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

export function acquireSingleInstanceLock(paths: LockPathOptions = {}): LockPaths {
  assertLegacyLockNotHeldByLiveDaemon(paths);

  const resolved = resolveLockPaths(paths);
  // mg-AC-4 parity: when this mkdir is the FIRST creator of the hive state dir (a no-op-injected
  // migration seam, or a standalone caller), it must apply the same 0o700 the migration applies,
  // so the dir that later holds the 0600 onboarding token is never left at umask-default modes.
  mkdirSync(dirname(resolved.lockFilePath), { recursive: true, mode: 0o700 });
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

    removeStaleLegacyLockArtifacts(paths);
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
