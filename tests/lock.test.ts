import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAlreadyRunningError } from "../src/errors.js";
import {
  acquireSingleInstanceLock,
  readPidFile,
  releaseSingleInstanceLock
} from "../src/lock.js";

async function withTempLockPaths(run: (paths: { lockFilePath: string; pidFilePath: string }) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thehive-lock-test-"));
  const lockPaths = {
    lockFilePath: join(dir, "thehive.lock"),
    pidFilePath: join(dir, "thehive.pid")
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
