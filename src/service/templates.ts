import { WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";

export const HIVE_START_COMMAND = "start" as const;
export const RESTART_SEC = 5 as const;
export const WINDOWS_RESTART_INTERVAL = "PT1M" as const;

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

export function renderLaunchdPlist(plan: ServicePlan): string {
  const node = escapeXml(process.execPath);
  const exec = escapeXml(plan.execPath);
  const home = escapeXml(plan.home);
  const label = escapeXml(plan.label);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
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
	<key>StandardOutPath</key>
	<string>${home}/.honeycomb/hive/launchd.out.log</string>
	<key>StandardErrorPath</key>
	<string>${home}/.honeycomb/hive/launchd.err.log</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(plan: ServicePlan): string {
  const execStart = `${quoteSystemdToken(process.execPath)} ${quoteSystemdToken(plan.execPath)} ${HIVE_START_COMMAND}`;
  return `[Unit]
Description=hive portal daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=${RESTART_SEC}
StartLimitIntervalSec=0

[Install]
WantedBy=default.target
`;
}

export function renderScheduledTaskXml(plan: ServicePlan): string {
  const node = escapeXml(process.execPath);
  const exec = escapeXml(plan.execPath);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>hive portal daemon</Description>
    <URI>\\${escapeXml(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
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
      <Command>${node}</Command>
      <Arguments>"${exec}" ${HIVE_START_COMMAND}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function renderUnit(plan: ServicePlan): string {
  switch (plan.manager) {
    case "launchd":
      return renderLaunchdPlist(plan);
    case "systemd":
      return renderSystemdUnit(plan);
    case "schtasks":
      return renderScheduledTaskXml(plan);
  }
}
