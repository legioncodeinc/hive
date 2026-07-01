import { SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";

export interface ServiceCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function launchdDomainTarget(uid: number): string {
  return `gui/${uid}`;
}

export function launchdServiceTarget(plan: ServicePlan, uid: number): string {
  return `${launchdDomainTarget(uid)}/${plan.label}`;
}

export function installCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [
        { command: "launchctl", args: ["bootstrap", launchdDomainTarget(uid), plan.unitPath] },
        { command: "launchctl", args: ["kickstart", "-k", launchdServiceTarget(plan, uid)] }
      ];
    case "systemd":
      return [{ command: "systemctl", args: ["--user", "enable", "--now", SYSTEMD_UNIT_NAME] }];
    case "schtasks":
      return [
        { command: "schtasks", args: ["/Create", "/XML", plan.unitPath, "/TN", WINDOWS_TASK_NAME, "/F"] },
        { command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] }
      ];
  }
}

export function uninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] }];
    case "systemd":
      return [{ command: "systemctl", args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME] }];
    case "schtasks":
      return [{ command: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"] }];
  }
}
