import {
  launchdDomainTarget,
  launchdServiceTarget,
  startCommands,
  stopCommands,
  uninstallCommands
} from "../../src/service/commands.js";
import { SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from "../../src/service/platform.js";
import { fixedEnv } from "./helpers.js";
import { resolveServicePlan } from "../../src/service/platform.js";

describe("service stop commands", () => {
  it("b-AC-1 launchd stop uses bootout without removing the unit", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/home/t" }));
    const uid = 501;
    expect(stopCommands(plan, uid)).toEqual([
      {
        command: "launchctl",
        args: ["bootout", launchdServiceTarget(plan, uid)]
      }
    ]);
    expect(uninstallCommands(plan, uid)[0]?.args).toEqual(["bootout", launchdServiceTarget(plan, uid)]);
    expect(launchdServiceTarget(plan, uid)).toBe(`${launchdDomainTarget(uid)}/${plan.label}`);
  });

  it("b-AC-1 systemd stop uses stop without disable", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "linux", home: "/home/t" }));
    expect(stopCommands(plan, 1000)).toEqual([
      { command: "systemctl", args: ["--user", "stop", SYSTEMD_UNIT_NAME] }
    ]);
    expect(uninstallCommands(plan, 1000)[0]?.args).toEqual(["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
  });

  it("b-AC-1 schtasks stop uses /End without /Delete", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", home: "C:\\Users\\t" }));
    expect(stopCommands(plan, 0)).toEqual([{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] }]);
    expect(uninstallCommands(plan, 0)[0]?.args).toEqual(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  });
});

describe("service start commands", () => {
  it("uses fixed product-owned argv on all platforms", () => {
    const launchd = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/home/t" }));
    const systemd = resolveServicePlan(fixedEnv({ platform: "linux", home: "/home/t" }));
    const windows = resolveServicePlan(fixedEnv({ platform: "win32", home: "C:\\Users\\t" }));

    expect(startCommands(launchd, 501)).toEqual([
      { command: "launchctl", args: ["kickstart", launchdServiceTarget(launchd, 501)] }
    ]);
    expect(startCommands(systemd, 1000)).toEqual([
      { command: "systemctl", args: ["--user", "start", SYSTEMD_UNIT_NAME] }
    ]);
    expect(startCommands(windows, 0)).toEqual([
      { command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] }
    ]);
  });
});
