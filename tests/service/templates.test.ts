import { resolveServicePlan } from "../../src/service/platform.js";
import { resolveLaunchdLogPaths } from "../../src/shared/apiary-root.js";
import {
  apiaryHomePin,
  quoteSystemdToken,
  RESTART_SEC,
  renderLaunchdPlist,
  renderScheduledTaskXml,
  renderSystemdUnit,
  HIVE_START_COMMAND,
  WINDOWS_RESTART_INTERVAL
} from "../../src/service/templates.js";
import { fixedEnv } from "./helpers.js";

describe("hive service templates", () => {
  it("rr-AC-10 pins APIARY_HOME into the launchd EnvironmentVariables dict when an override root is active", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan, { APIARY_HOME: "/custom/fleet-root" });

    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>APIARY_HOME</key>");
    expect(xml).toContain("<string>/custom/fleet-root</string>");
    // The unit's log paths and the pinned root agree (the W-1 coherence requirement).
    const logs = resolveLaunchdLogPaths({ home: "/Users/t", env: { APIARY_HOME: "/custom/fleet-root" } });
    expect(xml).toContain(`<string>${logs.out}</string>`);
  });

  it("rr-AC-10 XML-escapes a metacharacter-bearing pinned root in the launchd plist", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan, { APIARY_HOME: "/custom/a&b<c>" });

    expect(xml).toContain("<string>/custom/a&amp;b&lt;c&gt;</string>");
    expect(xml).not.toContain("<string>/custom/a&b<c></string>");
  });

  it("rr-AC-10 pins Environment= into the systemd unit when an override root is active", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" }));
    const unit = renderSystemdUnit(plan, { APIARY_HOME: "/custom/fleet-root" });

    expect(unit).toContain(`Environment="APIARY_HOME=/custom/fleet-root"`);
  });

  it("rr-AC-10 renders no APIARY_HOME pin for a default install", () => {
    const darwinPlan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const linuxPlan = resolveServicePlan(fixedEnv({ platform: "linux", home: "/home/t", execPath: "/opt/hive/dist/cli.js" }));

    expect(renderLaunchdPlist(darwinPlan, {})).not.toContain("APIARY_HOME");
    expect(renderSystemdUnit(linuxPlan, {})).not.toContain("APIARY_HOME");
    expect(apiaryHomePin(darwinPlan, {})).toBeNull();
  });

  it("rr-AC-9 renders launchd log paths under the fleet hive state dir", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan);
    const logs = resolveLaunchdLogPaths({ home: "/Users/t", env: process.env });

    expect(xml).toContain(`<string>${logs.out}</string>`);
    expect(xml).toContain(`<string>${logs.err}</string>`);
  });

  it("d-AC-2/d-AC-3 renders launchd boot+restart settings", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan);

    expect(xml).toContain("<string>com.legioncode.hive</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain(`<integer>${RESTART_SEC}</integer>`);
    expect(xml).toContain(`<string>${HIVE_START_COMMAND}</string>`);
  });

  it("d-AC-2/d-AC-3 renders systemd restart-always + wanted-by directives", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "linux", execPath: "/opt/hive/dist/cli.js" }));
    const unit = renderSystemdUnit(plan);

    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(quoteSystemdToken(process.execPath));
    expect(unit).toContain(`${quoteSystemdToken("/opt/hive/dist/cli.js")} ${HIVE_START_COMMAND}`);
  });

  it("d-AC-2/d-AC-3 renders schtasks restart-on-failure + logon trigger", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const xml = renderScheduledTaskXml(plan);

    expect(xml).toContain("<URI>\\hive</URI>");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`);
    expect(xml).toContain(`<Arguments>"C:\\hive\\dist\\cli.js" ${HIVE_START_COMMAND}</Arguments>`);
  });
});
