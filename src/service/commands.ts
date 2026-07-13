import {
  LEGACY_SERVICE_LABEL,
  LEGACY_SYSTEMD_UNIT_NAME,
  LEGACY_WINDOWS_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  type ServicePlan
} from "./platform.js";

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

export function stopCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] }];
    case "systemd":
      return [{ command: "systemctl", args: ["--user", "stop", SYSTEMD_UNIT_NAME] }];
    case "schtasks":
      return [{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] }];
  }
}

/** Start an already-installed service without rewriting or re-registering its unit. */
export function startCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["kickstart", launchdServiceTarget(plan, uid)] }];
    case "systemd":
      return [{ command: "systemctl", args: ["--user", "start", SYSTEMD_UNIT_NAME] }];
    case "schtasks":
      return [{ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] }];
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

/**
 * The argv to deregister the PRE-decision-#32 unit names (`thehive` / `thehive.service`).
 * Run best-effort at the start of every install so a re-run migrates a legacy unit;
 * when no legacy unit exists these commands fail harmlessly and the install proceeds.
 */
export function legacyUninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
  switch (plan.manager) {
    case "launchd":
      return [{ command: "launchctl", args: ["bootout", `${launchdDomainTarget(uid)}/${LEGACY_SERVICE_LABEL}`] }];
    case "systemd":
      return [{ command: "systemctl", args: ["--user", "disable", "--now", LEGACY_SYSTEMD_UNIT_NAME] }];
    case "schtasks":
      return [{ command: "schtasks", args: ["/Delete", "/TN", LEGACY_WINDOWS_TASK_NAME, "/F"] }];
  }
}
