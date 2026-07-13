import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveFleetRoot,
  resolveHiveLockPath,
  resolveHivePidPath,
  resolveHiveStateDir,
  resolveLaunchdLogPaths,
  resolveSharedInstallIdPath,
  resolveStagedWindowsTaskPath
} from "../../src/shared/apiary-root.js";

describe("resolveFleetRoot (rr-AC-1..4)", () => {
  it("rr-AC-1 defaults to <home>/.apiary on macOS and Windows", () => {
    const home = "/Users/tester";
    expect(resolveFleetRoot({ home, platform: "darwin", env: {} })).toBe(join(home, ".apiary"));
    expect(resolveFleetRoot({ home: "C:\\Users\\tester", platform: "win32", env: {} })).toBe(
      join("C:\\Users\\tester", ".apiary")
    );
  });

  it("rr-AC-1 honors Linux XDG_STATE_HOME only when explicitly set", () => {
    const home = "/home/tester";
    expect(resolveFleetRoot({ home, platform: "linux", env: {} })).toBe(join(home, ".apiary"));
    expect(resolveFleetRoot({ home, platform: "linux", env: { XDG_STATE_HOME: "/xdg/state" } })).toBe(
      join("/xdg/state", "apiary")
    );
  });

  it("rr-AC-1 ignores a relative XDG_STATE_HOME (XDG spec: relative values are invalid; never cwd-anchored)", () => {
    const home = "/home/tester";
    expect(resolveFleetRoot({ home, platform: "linux", env: { XDG_STATE_HOME: "relative/state" } })).toBe(
      join(home, ".apiary")
    );
  });

  it("rr-AC-2 prefers APIARY_HOME over XDG and home default", () => {
    const home = "/home/tester";
    expect(
      resolveFleetRoot({
        home,
        platform: "linux",
        env: { APIARY_HOME: "/custom/apiary", XDG_STATE_HOME: "/xdg/state" }
      })
    ).toBe("/custom/apiary");
  });

  it("rr-AC-3 ignores a relative APIARY_HOME (fleet rule: env roots honored only when absolute; never cwd-anchored)", () => {
    const home = "/home/tester";
    expect(resolveFleetRoot({ home, platform: "linux", env: { APIARY_HOME: "fleet-root" } })).toBe(
      join(home, ".apiary")
    );
  });

  it("rr-AC-4 places hive state and pid/lock under <root>/hive", () => {
    const home = "/home/tester";
    const deps = { home, platform: "linux" as const, env: {} };
    const root = resolveFleetRoot(deps);
    expect(resolveHiveStateDir(deps)).toBe(join(root, "hive"));
    expect(resolveHivePidPath(deps)).toBe(join(root, "hive", "hive.pid"));
    expect(resolveHiveLockPath(deps)).toBe(join(root, "hive", "hive.lock"));
    expect(resolveSharedInstallIdPath(deps)).toBe(join(root, "install-id"));
    expect(resolveStagedWindowsTaskPath(deps)).toBe(join(root, "hive", "hive-task.xml"));
    expect(resolveLaunchdLogPaths(deps).out).toBe(join(root, "hive", "service.log"));
  });

  it("rr-AC-1 production default uses os.homedir()", () => {
    expect(resolveFleetRoot({ env: {}, platform: process.platform as NodeJS.Platform })).toBe(
      join(homedir(), ".apiary")
    );
  });
});
