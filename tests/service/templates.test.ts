import { resolveServicePlan } from "../../src/service/platform.js";
import {
  apiaryHomePin,
  quoteSystemdToken,
  RESTART_SEC,
  renderLaunchdPlist,
  renderScheduledTaskXml,
  renderSystemdUnit,
  renderUnit,
  HIVE_START_COMMAND,
  WINDOWS_CONHOST_COMMAND,
  WINDOWS_RESTART_INTERVAL
} from "../../src/service/templates.js";
import { fixedEnv } from "./helpers.js";

describe("hive service templates", () => {
  it("AC-b9 pins every platform to the fixed service-daemon logging boundary", () => {
    const launchd = renderLaunchdPlist(resolveServicePlan(fixedEnv({ platform: "darwin", execPath: "/opt/hive/dist/cli.js" })));
    const systemd = renderSystemdUnit(resolveServicePlan(fixedEnv({ platform: "linux", execPath: "/opt/hive/dist/cli.js" })));
    const windows = renderScheduledTaskXml(resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" })));

    expect(launchd).toContain(`<string>${HIVE_START_COMMAND}</string>`);
    expect(systemd).toContain(` ${HIVE_START_COMMAND}\n`);
    expect(windows).toContain(` ${HIVE_START_COMMAND}</Arguments>`);
    expect(`${launchd}\n${systemd}`).not.toMatch(/StandardOut(?:Path|put)|StandardErr(?:orPath|or)/);
  });

  it("rr-AC-10 pins APIARY_HOME into the launchd EnvironmentVariables dict when an override root is active", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan, { APIARY_HOME: "/custom/fleet-root" });

    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>APIARY_HOME</key>");
    expect(xml).toContain("<string>/custom/fleet-root</string>");
    // The service wrapper receives the same pinned root and owns symlink-safe log opening.
    expect(xml).toContain(`<string>${HIVE_START_COMMAND}</string>`);
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

  it("rr-AC-9 delegates log ownership to the cross-platform service wrapper", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/hive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan);

    expect(xml).toContain(`<string>${HIVE_START_COMMAND}</string>`);
    expect(xml).not.toContain("StandardOutPath");
    expect(xml).not.toContain("StandardErrorPath");
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
    expect(unit).not.toContain("StandardOutput=");
    expect(unit).not.toContain("StandardError=");
  });

  it("d-AC-2/d-AC-3 renders schtasks restart-on-failure + logon trigger", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const xml = renderScheduledTaskXml(plan);

    expect(xml).toContain("<URI>\\hive</URI>");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`);
  });

  it("wraps the schtasks action in conhost --headless so no console window pops at logon/run", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const xml = renderScheduledTaskXml(plan);

    expect(xml).toContain(`<Command>${WINDOWS_CONHOST_COMMAND}</Command>`);
    expect(xml).toContain(
      `<Arguments>--headless "${process.execPath}" "C:\\hive\\dist\\cli.js" ${HIVE_START_COMMAND}</Arguments>`
    );
    expect(xml).not.toContain(`<Command>${process.execPath}</Command>`);
  });

  it("renders no UserId in LogonTrigger/Principal when no identity was resolved (prior unscoped behavior)", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const xml = renderScheduledTaskXml(plan, null);

    expect(xml).not.toContain("<UserId>");
  });

  it("scopes the LogonTrigger and Principal to the resolved SID so schtasks registers without elevation", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
    const xml = renderScheduledTaskXml(plan, sid);

    // Exactly two UserId elements: one scoping the LogonTrigger, one scoping the Principal.
    expect(xml.split(`<UserId>${sid}</UserId>`)).toHaveLength(3);
    const logonTriggerBlock = xml.slice(xml.indexOf("<LogonTrigger>"), xml.indexOf("</LogonTrigger>"));
    expect(logonTriggerBlock).toContain(`<UserId>${sid}</UserId>`);
    const principalBlock = xml.slice(xml.indexOf('<Principal id="Author">'), xml.indexOf("</Principal>"));
    expect(principalBlock).toContain(`<UserId>${sid}</UserId>`);
    // Per the Task Scheduler schema, UserId comes first inside Principal.
    expect(principalBlock.indexOf("<UserId>")).toBeLessThan(principalBlock.indexOf("<LogonType>"));
  });

  it("XML-escapes a fallback domain\\user account rendered as UserId", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const xml = renderScheduledTaskXml(plan, "DOMAIN&<>\\user'\"");

    expect(xml).toContain("<UserId>DOMAIN&amp;&lt;&gt;\\user&apos;&quot;</UserId>");
    expect(xml).not.toContain("<UserId>DOMAIN&<>\\user'\"</UserId>");
  });

  it("renderUnit threads the resolved Windows UserId through to the schtasks XML only", () => {
    const winPlan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\hive\\dist\\cli.js" }));
    const linuxPlan = resolveServicePlan(fixedEnv({ platform: "linux", execPath: "/opt/hive/dist/cli.js" }));
    const sid = "S-1-5-21-1-2-3-1001";

    expect(renderUnit(winPlan, process.env, sid)).toContain(`<UserId>${sid}</UserId>`);
    expect(renderUnit(linuxPlan, {}, sid)).not.toContain(sid);
  });
});
