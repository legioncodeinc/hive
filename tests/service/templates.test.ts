import { resolveServicePlan } from "../../src/service/platform.js";
import {
  quoteSystemdToken,
  RESTART_SEC,
  renderLaunchdPlist,
  renderScheduledTaskXml,
  renderSystemdUnit,
  THEHIVE_START_COMMAND,
  WINDOWS_RESTART_INTERVAL
} from "../../src/service/templates.js";
import { fixedEnv } from "./helpers.js";

describe("thehive service templates", () => {
  it("d-AC-2/d-AC-3 renders launchd boot+restart settings", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/thehive/dist/cli.js" }));
    const xml = renderLaunchdPlist(plan);

    expect(xml).toContain("<string>thehive</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain(`<integer>${RESTART_SEC}</integer>`);
    expect(xml).toContain(`<string>${THEHIVE_START_COMMAND}</string>`);
  });

  it("d-AC-2/d-AC-3 renders systemd restart-always + wanted-by directives", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "linux", execPath: "/opt/thehive/dist/cli.js" }));
    const unit = renderSystemdUnit(plan);

    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(quoteSystemdToken(process.execPath));
    expect(unit).toContain(`${quoteSystemdToken("/opt/thehive/dist/cli.js")} ${THEHIVE_START_COMMAND}`);
  });

  it("d-AC-2/d-AC-3 renders schtasks restart-on-failure + logon trigger", () => {
    const plan = resolveServicePlan(fixedEnv({ platform: "win32", execPath: "C:\\thehive\\dist\\cli.js" }));
    const xml = renderScheduledTaskXml(plan);

    expect(xml).toContain("<URI>\\thehive</URI>");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`);
    expect(xml).toContain(`<Arguments>"C:\\thehive\\dist\\cli.js" ${THEHIVE_START_COMMAND}</Arguments>`);
  });
});
