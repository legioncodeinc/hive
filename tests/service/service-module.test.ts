import { createServiceModule } from "../../src/service/index.js";
import { fixedEnv, createMemoryFs, createRecordingRunner } from "./helpers.js";

describe("thehive service module", () => {
  it("d-AC-1 writes Linux unit content before systemctl enable", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/thehive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/thehive/dist/cli.js" })
    });

    const result = await service.install();
    const unitPath = "/home/t/.config/systemd/user/hive.service";

    expect(result.ok).toBe(true);
    expect(fs.files.has(unitPath)).toBe(true);
    expect(fs.files.get(unitPath)).toContain("Restart=always");
    expect(fs.files.get(unitPath)).toContain(`"/opt/thehive/dist/cli.js" start`);
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

  it("d-AC-1 stages Windows XML under ~/.honeycomb/thehive and creates schtask", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "C:\\thehive\\dist\\cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\thehive\\dist\\cli.js" })
    });

    const result = await service.install();
    const stagedPath = "C:\\Users\\t/.honeycomb/thehive/thehive-task.xml";

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

  it("d-AC-4 uninstall removes the hive unit only and never touches hivedoctor paths", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const hiveUnit = "/home/t/.config/systemd/user/hive.service";
    const hivedoctorUnit = "/home/t/.config/systemd/user/doctor.service";
    fs.files.set(hiveUnit, "hive unit");
    fs.files.set(hivedoctorUnit, "doctor unit");

    const service = createServiceModule({
      execPath: "/opt/thehive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/thehive/dist/cli.js" })
    });

    const result = await service.uninstall();

    expect(result.ok).toBe(true);
    expect(fs.removed).toContain(hiveUnit);
    expect(fs.removed).not.toContain(hivedoctorUnit);
    expect(runner.calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "hive.service"]
    });
    expect(runner.calls.some((call) => call.args.some((arg) => arg.includes("doctor")))).toBe(false);
  });
});
