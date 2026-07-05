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

  it("b-AC-1 stop uses systemctl stop without disable", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.stop();

    expect(result.ok).toBe(true);
    expect(runner.calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "stop", "hive.service"]
    });
  });

  it("rr-AC-10 stages Windows XML under the fleet hive state dir and creates schtask", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
    const service = createServiceModule({
      execPath: "C:\\hive\\dist\\cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\hive\\dist\\cli.js" }),
      migrateState: () => {},
      resolveWindowsUserId: () => Promise.resolve(sid)
    });

    const result = await service.install();
    const stagedPath = resolveStagedWindowsTaskPath({ home: "C:\\Users\\t", env: process.env });

    expect(result.ok).toBe(true);
    const xml = fs.files.get(stagedPath);
    expect(xml).toContain("<Task ");
    // BUG 1 fix: the LogonTrigger and Principal are scoped to the resolved SID, so schtasks
    // registers without elevation on a hardened Windows 11 25H2 machine.
    expect(xml).toContain(`<UserId>${sid}</UserId>`);
    // BUG 2 fix: the action runs under conhost --headless, so no console window pops.
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toContain("--headless");
    expect(runner.calls[0]).toEqual({
      command: "schtasks",
      args: ["/Delete", "/TN", "thehive", "/F"]
    });
    expect(runner.calls[1]).toEqual({
      command: "schtasks",
      args: ["/Create", "/XML", stagedPath, "/TN", "hive", "/F"]
    });
  });

  it("rr-AC-10 falls back to an unscoped UserId-less task XML when the SID cannot be resolved", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "C:\\hive\\dist\\cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\hive\\dist\\cli.js" }),
      migrateState: () => {},
      resolveWindowsUserId: () => Promise.resolve(null)
    });

    const result = await service.install();
    const stagedPath = resolveStagedWindowsTaskPath({ home: "C:\\Users\\t", env: process.env });

    expect(result.ok).toBe(true);
    expect(fs.files.get(stagedPath)).not.toContain("<UserId>");
  });

  it("rr-AC-10 never invokes the Windows SID resolver for a non-Windows plan", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    let resolverCalls = 0;
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" }),
      migrateState: () => {},
      resolveWindowsUserId: () => {
        resolverCalls += 1;
        return Promise.resolve("S-1-5-21-1-2-3-1001");
      }
    });

    await service.install();

    expect(resolverCalls).toBe(0);
  });

  it("b-AC-2 uninstall deregisters legacy and current units", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const hiveUnit = "/home/t/.config/systemd/user/hive.service";
    const legacyUnit = "/home/t/.config/systemd/user/thehive.service";
    fs.files.set(hiveUnit, "hive unit");
    fs.files.set(legacyUnit, "legacy unit");

    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.uninstall();

    expect(result.ok).toBe(true);
    expect(fs.removed).toContain(hiveUnit);
    expect(fs.removed).toContain(legacyUnit);
    expect(runner.calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "thehive.service"]
    });
    expect(runner.calls[1]).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "hive.service"]
    });
  });

  it("M-2 uninstall classifies a launchd exit 3 (double bootout) as already absent, not a failure", async () => {
    // Reproduces the finding: `stop` already ran `launchctl bootout` for the current
    // unit, so uninstall's own bootout of the SAME unit finds "No such process"
    // (launchd exit 3) even though everything already succeeded.
    const runner = createRecordingRunner((command, args) => {
      if (command === "launchctl" && args[0] === "bootout") {
        return { ok: false, code: 3, stdout: "", stderr: "No such process" };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.uninstall();

    expect(result.ok).toBe(false);
    expect(result.alreadyAbsent).toBe(true);
    expect(result.message).toContain("already absent");
  });

  it("M-2 uninstall classifies a schtasks not-found failure as already absent (friendly no-op)", async () => {
    const runner = createRecordingRunner((command) => {
      if (command === "schtasks") {
        return { ok: false, code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "C:\\hive\\dist\\cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\hive\\dist\\cli.js" })
    });

    const result = await service.uninstall();

    expect(result.ok).toBe(false);
    expect(result.alreadyAbsent).toBe(true);
    expect(result.message).toContain("already absent");
  });

  it("M-2 uninstall surfaces a genuine current-unit failure instead of swallowing it", async () => {
    const runner = createRecordingRunner((command, args) => {
      if (command === "systemctl" && args.includes("hive.service")) {
        return { ok: false, code: 1, stdout: "", stderr: "Access is denied." };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.uninstall();

    expect(result.ok).toBe(false);
    expect(result.alreadyAbsent).toBe(false);
    expect(result.message).toContain("Access is denied.");
  });

  it("M-2 stop treats an already-not-running unit as a friendly no-op", async () => {
    const runner = createRecordingRunner(() => ({ ok: false, code: 3, stdout: "", stderr: "No such process" }));
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.stop();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("already stopped");
  });

  it("M-2 stop surfaces a genuine stop failure instead of swallowing it", async () => {
    const runner = createRecordingRunner(() => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "Operation not permitted"
    }));
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" })
    });

    const result = await service.stop();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Operation not permitted");
  });

  it("b-AC-6 isRegistered keys on the current unit file for systemd", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" })
    });

    expect(await service.isRegistered()).toBe(false);
    fs.files.set("/home/t/.config/systemd/user/hive.service", "hive unit");
    expect(await service.isRegistered()).toBe(true);
    // File existence answers registration on unit-file platforms; no manager command runs.
    expect(runner.calls).toEqual([]);
  });

  it("b-AC-6 isRegistered detects a legacy-only unit file (launchd)", async () => {
    const runner = createRecordingRunner();
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" })
    });

    expect(await service.isRegistered()).toBe(false);
    fs.files.set("/Users/t/Library/LaunchAgents/thehive.plist", "legacy unit");
    expect(await service.isRegistered()).toBe(true);
  });

  it("b-AC-6 isRegistered queries schtasks for current then legacy task names on win32", async () => {
    const okTasks = new Set<string>();
    const runner = createRecordingRunner((command, args) => {
      if (command === "schtasks" && args[0] === "/Query") {
        const task = args[2] ?? "";
        return okTasks.has(task)
          ? { ok: true, code: 0, stdout: `TaskName: \\${task}`, stderr: "" }
          : { ok: false, code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    const fs = createMemoryFs();
    const service = createServiceModule({
      execPath: "C:\\hive\\dist\\cli.js",
      runner,
      fs,
      environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\hive\\dist\\cli.js" })
    });

    expect(await service.isRegistered()).toBe(false);
    expect(runner.calls[0]).toEqual({ command: "schtasks", args: ["/Query", "/TN", "hive"] });
    expect(runner.calls[1]).toEqual({ command: "schtasks", args: ["/Query", "/TN", "thehive"] });

    okTasks.add("thehive");
    expect(await service.isRegistered()).toBe(true);

    okTasks.clear();
    okTasks.add("hive");
    expect(await service.isRegistered()).toBe(true);
  });

  it("b-AC-6 isRegistered answers false instead of throwing on an unsupported platform", async () => {
    const service = createServiceModule({
      execPath: "/opt/hive/dist/cli.js",
      runner: createRecordingRunner(),
      fs: createMemoryFs(),
      environment: fixedEnv({ platform: "aix", home: "/home/t", execPath: "/opt/hive/dist/cli.js" })
    });

    expect(await service.isRegistered()).toBe(false);
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
    expect(runner.calls.some((call) => call.args.some((arg) => arg.includes("doctor")))).toBe(false);
  });
});
