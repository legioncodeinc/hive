import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";

import { runServiceDaemon } from "../../src/service/daemon-wrapper.js";
import { resolveServiceLogPaths } from "../../src/shared/apiary-root.js";

describe("service daemon wrapper", () => {
  it("spawns the foreground daemon with fixed argv, no shell, and Hive-owned logs", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-service-wrapper-"));
    try {
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, "killed", { value: false, writable: true });
      child.kill = vi.fn(() => true);
      const spawnChild = vi.fn(() => {
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as unknown as typeof spawn;
      const fleetRoot = { home, env: {}, platform: "linux" as const };

      expect(await runServiceDaemon("/opt/hive/dist/cli.js", { fleetRoot, spawnChild })).toBe(0);
      expect(spawnChild).toHaveBeenCalledWith(
        process.execPath,
        ["/opt/hive/dist/cli.js", "daemon"],
        expect.objectContaining({ shell: false, windowsHide: true })
      );
      expect(existsSync(resolveServiceLogPaths(fleetRoot).out)).toBe(true);
      if (process.platform !== "win32") expect(statSync(resolveServiceLogPaths(fleetRoot).out).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("repairs permissive permissions on an existing service log", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-service-wrapper-mode-"));
    try {
      const fleetRoot = { home, env: {}, platform: "linux" as const };
      const log = resolveServiceLogPaths(fleetRoot).out;
      mkdirSync(join(home, ".apiary", "hive"), { recursive: true });
      writeFileSync(log, "existing");
      chmodSync(log, 0o666);
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, "killed", { value: false, writable: true });
      child.kill = vi.fn(() => true);
      const spawnChild = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0, null)); return child; }) as unknown as typeof spawn;
      expect(await runServiceDaemon("/opt/hive/dist/cli.js", { fleetRoot, spawnChild })).toBe(0);
      if (process.platform !== "win32") expect(statSync(log).mode & 0o777).toBe(0o600);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("refuses a symlinked service log without spawning the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-service-wrapper-link-"));
    try {
      const fleetRoot = { home, env: {}, platform: "linux" as const };
      const log = resolveServiceLogPaths(fleetRoot).out;
      const target = join(home, "victim.txt");
      mkdirSync(join(home, ".apiary", "hive"), { recursive: true });
      writeFileSync(target, "untouched");
      symlinkSync(target, log, "file");
      const spawnChild = vi.fn() as unknown as typeof spawn;
      expect(await runServiceDaemon("/opt/hive/dist/cli.js", { fleetRoot, spawnChild })).toBe(1);
      expect(spawnChild).not.toHaveBeenCalled();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
