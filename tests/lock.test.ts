import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAlreadyRunningError } from "../src/errors.js";
import {
  acquireSingleInstanceLock,
  readPidFile,
  releaseSingleInstanceLock,
  resolveLockPaths
} from "../src/lock.js";
import { resolveFleetRoot, resolveHiveLockPath, resolveHivePidPath } from "../src/shared/apiary-root.js";
import { resolveLegacyHiveLockPath, resolveLegacyHivePidPath } from "../src/shared/legacy-paths.js";

async function withTempLockPaths(run: (paths: { lockFilePath: string; pidFilePath: string }) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hive-lock-test-"));
  const lockPaths = {
    lockFilePath: join(dir, "hive.lock"),
    pidFilePath: join(dir, "hive.pid")
  };
  try {
    await run(lockPaths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("single-instance lock", () => {
  it("a-AC-4 writes pid and lock files", () => {
    return withTempLockPaths((lockPaths) => {
      const acquired = acquireSingleInstanceLock(lockPaths);

      expect(readPidFile(acquired.lockFilePath)).toBe(process.pid);
      expect(readPidFile(acquired.pidFilePath)).toBe(process.pid);
    });
  });

  it("mg-AC-5 blocks when a live legacy lock is still held", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-legacy-lock-"));
    try {
      const legacyLock = resolveLegacyHiveLockPath({ home });
      const legacyPid = resolveLegacyHivePidPath({ home });
      mkdirSync(join(legacyLock, ".."), { recursive: true });
      writeFileSync(legacyLock, String(process.pid), "utf8");
      writeFileSync(legacyPid, String(process.pid), "utf8");

      expect(() =>
        acquireSingleInstanceLock({
          home,
          lockFilePath: resolveHiveLockPath({ home }),
          pidFilePath: resolveHivePidPath({ home })
        })
      ).toThrowError(DaemonAlreadyRunningError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mg-AC-6 removes stale legacy pid/lock after acquiring the new lock", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-legacy-lock-"));
    try {
      const legacyLock = resolveLegacyHiveLockPath({ home });
      const legacyPid = resolveLegacyHivePidPath({ home });
      mkdirSync(join(legacyLock, ".."), { recursive: true });
      writeFileSync(legacyLock, "999999999", "utf8");
      writeFileSync(legacyPid, "999999999", "utf8");

      acquireSingleInstanceLock({
        home,
        lockFilePath: resolveHiveLockPath({ home }),
        pidFilePath: resolveHivePidPath({ home })
      });

      expect(existsSync(legacyLock)).toBe(false);
      expect(existsSync(legacyPid)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rr-AC-5 default lock paths resolve to <fleetRoot>/hive/hive.pid|.lock", () => {
    const resolved = resolveLockPaths();
    expect(resolved.pidFilePath).toBe(resolveHivePidPath());
    expect(resolved.lockFilePath).toBe(resolveHiveLockPath());
    expect(resolved.pidFilePath).toBe(join(resolveFleetRoot(), "hive", "hive.pid"));
    expect(resolved.lockFilePath).toBe(join(resolveFleetRoot(), "hive", "hive.lock"));
  });

  it("mg-AC-6 a throwing legacy cleanup never blocks acquisition (best-effort)", () => {
    const home = mkdtempSync(join(tmpdir(), "hive-legacy-lock-"));
    try {
      // Make the legacy lock path a NON-EMPTY DIRECTORY: existsSync sees it, readPidFile reads
      // null (not a live daemon), and rmSync(..., { force: true }) without recursive THROWS,
      // simulating the EBUSY/EPERM class of cleanup failure.
      const legacyLock = resolveLegacyHiveLockPath({ home });
      mkdirSync(legacyLock, { recursive: true });
      writeFileSync(join(legacyLock, "occupant"), "x", "utf8");

      const acquired = acquireSingleInstanceLock({
        home,
        lockFilePath: resolveHiveLockPath({ home }),
        pidFilePath: resolveHivePidPath({ home })
      });

      // Acquisition succeeded despite the throwing cleanup; the stale legacy artifact remains
      // (retried next boot) and the new lock is held.
      expect(readPidFile(acquired.lockFilePath)).toBe(process.pid);
      expect(existsSync(legacyLock)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a-AC-5 blocks a second live start", () => {
    return withTempLockPaths((lockPaths) => {
      const acquired = acquireSingleInstanceLock(lockPaths);

      expect(() => acquireSingleInstanceLock(lockPaths)).toThrowError(DaemonAlreadyRunningError);
      releaseSingleInstanceLock(acquired);
    });
  });

  it("a-AC-6 reclaims stale lock files", () => {
    return withTempLockPaths((lockPaths) => {
      const stalePid = 999_999_999;

      writeFileSync(lockPaths.lockFilePath, String(stalePid), "utf8");
      writeFileSync(lockPaths.pidFilePath, String(stalePid), "utf8");

      const acquired = acquireSingleInstanceLock(lockPaths);
      expect(readFileSync(acquired.lockFilePath, "utf8").trim()).toBe(String(process.pid));
      expect(readFileSync(acquired.pidFilePath, "utf8").trim()).toBe(String(process.pid));
    });
  });

  it("release removes lock artifacts", () => {
    return withTempLockPaths((lockPaths) => {
      const acquired = acquireSingleInstanceLock(lockPaths);
      releaseSingleInstanceLock(acquired);

      expect(existsSync(acquired.lockFilePath)).toBe(false);
      expect(existsSync(acquired.pidFilePath)).toBe(false);
    });
  });
});
