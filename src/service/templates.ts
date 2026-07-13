import { join } from "node:path";

import { WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";
import { resolveFleetRoot } from "../shared/apiary-root.js";

/** Internal service wrapper. Canonical `start` controls the installed service. */
export const HIVE_START_COMMAND = "service-daemon" as const;
export const RESTART_SEC = 5 as const;
export const WINDOWS_RESTART_INTERVAL = "PT1M" as const;
/**
 * The task action runs under `conhost.exe --headless` instead of `node.exe` directly, so the
 * scheduled task never pops a visible console window at logon/run (proven empirically: the
 * identical task ran with Last Result 0 and no window under this wrapper).
 */
export const WINDOWS_CONHOST_COMMAND = "C:\\Windows\\System32\\conhost.exe" as const;

/**
 * rr-AC-10 / 010a implementation note: when the root resolved at render time differs from the
 * default `<home>/.apiary` (an `APIARY_HOME` or Linux XDG override is active), the installer must
 * pin `APIARY_HOME=<resolved root>` into the rendered unit so the manager-started daemon resolves
 * the SAME root the unit's embedded paths were rendered with. Returns `null` for default installs
 * (no pin rendered, no behavior change).
 */
export function apiaryHomePin(plan: ServicePlan, env: NodeJS.ProcessEnv): string | null {
  const resolved = resolveFleetRoot({ home: plan.home, env });
  return resolved === join(plan.home, ".apiary") ? null : resolved;
}

export function quoteSystemdToken(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchdPlist(plan: ServicePlan, env: NodeJS.ProcessEnv = process.env): string {
  const node = escapeXml(process.execPath);
  const exec = escapeXml(plan.execPath);
  const label = escapeXml(plan.label);
  const pin = apiaryHomePin(plan, env);
  const environmentBlock =
    pin === null
      ? ""
      : `	<key>EnvironmentVariables</key>
	<dict>
		<key>APIARY_HOME</key>
		<string>${escapeXml(pin)}</string>
	</dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${environmentBlock}	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${node}</string>
		<string>${exec}</string>
		<string>${HIVE_START_COMMAND}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>${RESTART_SEC}</integer>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(plan: ServicePlan, env: NodeJS.ProcessEnv = process.env): string {
  const execStart = `${quoteSystemdToken(process.execPath)} ${quoteSystemdToken(plan.execPath)} ${HIVE_START_COMMAND}`;
  const pin = apiaryHomePin(plan, env);
  const environmentLine = pin === null ? "" : `Environment=${quoteSystemdToken(`APIARY_HOME=${pin}`)}\n`;
  return `[Unit]
Description=hive portal daemon
After=network.target

[Service]
Type=simple
${environmentLine}ExecStart=${execStart}
Restart=always
RestartSec=${RESTART_SEC}
StartLimitIntervalSec=0

[Install]
WantedBy=default.target
`;
}

/**
 * rr-AC-10 Windows caveat (documented limitation): the Task Scheduler task XML has no environment
 * block, so an active `APIARY_HOME` override CANNOT be pinned into the task the way launchd
 * (`EnvironmentVariables`) and systemd (`Environment=`) pin it. Wrapping the action in a shell to
 * inject env is deliberately NOT done: the Arguments string is attacker-adjacent install input and
 * must stay free of shell interpolation (the existing escapeXml metacharacter guard is the whole
 * defense). Consequence: a Windows override install renders staged/unit paths under the override
 * root at render time, but the task-started daemon resolves the default root unless the operator
 * sets APIARY_HOME machine-wide (setx / system properties). Recorded in PRD-010a implementation
 * notes; hive's Windows service is per-user InteractiveToken only, so no LocalSystem edge exists.
 *
 * `userId` (a SID or a `domain\user` fallback, resolved by the caller and passed in already
 * escaped-ready) scopes the `LogonTrigger` and `Principal` to a concrete identity. An unscoped
 * logon trigger/principal means "any user's logon", which a hardened Windows 11 25H2 machine
 * (Administrator Protection enabled) refuses to register from a non-elevated shell. `null` renders
 * with no `UserId`, matching prior behavior for machines where no identity could be resolved.
 * `UserId` is placed first inside `<Principal>` and after `<Enabled>` inside `<LogonTrigger>` per
 * the Task Scheduler schema's element ordering.
 */
export function renderScheduledTaskXml(plan: ServicePlan, userId: string | null = null): string {
  const node = escapeXml(process.execPath);
  const exec = escapeXml(plan.execPath);
  const userIdBlock = userId === null ? "" : `\n      <UserId>${escapeXml(userId)}</UserId>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>hive portal daemon</Description>
    <URI>\\${escapeXml(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${userIdBlock}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${userIdBlock}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RestartOnFailure>
      <Interval>${WINDOWS_RESTART_INTERVAL}</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${WINDOWS_CONHOST_COMMAND}</Command>
      <Arguments>--headless "${node}" "${exec}" ${HIVE_START_COMMAND}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function renderUnit(
  plan: ServicePlan,
  env: NodeJS.ProcessEnv = process.env,
  windowsUserId: string | null = null
): string {
  switch (plan.manager) {
    case "launchd":
      return renderLaunchdPlist(plan, env);
    case "systemd":
      return renderSystemdUnit(plan, env);
    case "schtasks":
      return renderScheduledTaskXml(plan, windowsUserId);
  }
}
