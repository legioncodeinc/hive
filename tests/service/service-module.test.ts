import { createServiceModule } from "../../src/service/index.js";
import { resolveStagedWindowsTaskPath } from "../../src/shared/apiary-root.js";
import { fixedEnv, createMemoryFs, createRecordingRunner } from "./helpers.js";

describe("hive service module", () => {
  it("d-AC-1 writes Linux unit content before systemctl enable", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    let migrated = 0;
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" }),
      // Home isolation: the fake home must never reach the real filesystem migration.
      migrateState: () => {
        migrated += 1;
      }
    });

    const result = await service.install();
    const unitPath = "/home/t/.config/systemd/user/hive.service";

    expect(result.ok).toBe(true);
    // PRD-010b: install() converges hive state through the migration seam exactly once.
    expect(migrated).toBe(1);
    expect(fs.files.has(unitPath)).toBe(true);
    expect(fs.files.get(unitPath)).toContain("Restart=always");
    expect(fs.files.get(unitPath)).toContain(`"/opt/hive/dist/cli.js" start`);
    // Decision #32 migration: the legacy `thehive` unit is deregistered (and its
    // file removed) first, then the new unit is enabled.
    expect(runner.calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "thehive.service"]
    });
    expect(fs.removed).toContain("/home/t/.config/systemd/user/thehive.service");
    expect(runner.calls[1]).toEqual({
      command: "systemctl",
      args: ["--user", "enable", "--now", "hive.service"]
    });
  });

  it("rr-AC-10 stages Windows XML under the fleet hive state dir and creates schtask", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "C:\\hive\\dist\\cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\hive\\dist\\cli.js" }),
      migrateState: () => {}
    });

    const result = await service.install();
    // Derive the expected path from the SAME helper the code under test uses: the separator
    // between joined segments is platform-native (path.join), so a hardcoded backslash fixture
    // matches only on Windows and misses the memory-fs key on macOS/Linux CI.
    const stagedPath = resolveStagedWindowsTaskPath({ home: "C:\\Users\\t", env: process.env });

    expect(result.ok).toBe(true);
    expect(fs.files.get(stagedPath)).toContain("<Task ");
    // Decision #32 migration: the legacy `thehive` task is deleted first, then /Create runs.
    expect(runner.calls[0]).toEqual({
      command: "schtasks",
      args: ["/Delete", "/TN", "thehive", "/F"]
    });
    expect(runner.calls[1]).toEqual({
      command: "schtasks",
      args: ["/Create", "/XML", stagedPath, "/TN", "hive", "/F"]
    });
  });

  it("d-AC-4 uninstall removes the hive unit only and never touches doctor paths", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const hiveUnit = "/home/t/.config/systemd/user/hive.service";
    const doctorUnit = "/home/t/.config/systemd/user/doctor.service";
    fs.files.set(hiveUnit, "hive unit");
    fs.files.set(doctorUnit, "doctor unit");

    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.uninstall();

    expect(result.ok).toBe(true);
    expect(fs.removed).toContain(hiveUnit);
    expect(fs.removed).not.toContain(doctorUnit);
    expect(runner.calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "hive.service"]
    });
    expect(runner.calls.some((call) => call.args.some((arg) => arg.includes("doctor")))).toBe(false);
  });
});
