import { normalizePlatform, resolveServicePlan, SERVICE_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from "../../src/service/platform.js";
import { fixedEnv } from "./helpers.js";

describe("hive service platform resolution", () => {
  it("d-AC-1 maps macOS to launchd with a user LaunchAgent path", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t" }));
    expect(plan.manager).toBe("launchd");
    expect(plan.unitPath).toBe(`/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
    expect(plan.label).toBe("com.legioncode.hive");
  });

  it("d-AC-1 maps Linux to systemd user units", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "linux", home: "/home/t" }));
    expect(plan.manager).toBe("systemd");
    expect(plan.unitPath).toBe(`/home/t/.config/systemd/user/${SYSTEMD_UNIT_NAME}`);
  });

  it("d-AC-1 maps Windows to schtasks with deferred staged XML path", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", home: "C:\\Users\\t" }));
    expect(plan.manager).toBe("schtasks");
    expect(plan.unitPath).toBe("");
    expect(WINDOWS_TASK_NAME).toBe("hive");
  });

  it("rejects unsupported platforms with a clean error", () => {
    expect(() => resolveServicePlan(fixedEnv({ platform: "aix" }))).toThrow(/unsupported platform/);
    expect(normalizePlatform("aix")).toBeNull();
  });
});
