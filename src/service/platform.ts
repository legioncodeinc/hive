import { homedir } from "node:os";

export type ServicePlatform = "darwin" | "linux" | "win32";
export type ServiceManager = "launchd" | "systemd" | "schtasks";

/**
 * Decision #32 (2026-07-02, nectar `library/requirements/PRD-DECISIONS-AND-DEFAULTS.md`):
 * fleet-wide OS service naming uses the product short name `hive` with a
 * reverse-DNS launchd label, superseding the shipped `thehive` names.
 */
export const SERVICE_LABEL = "com.legioncode.hive" as const;
export const SYSTEMD_UNIT_NAME = "hive.service" as const;
export const WINDOWS_TASK_NAME = "hive" as const;

/** The pre-decision-#32 names, deregistered on install (migration path). */
export const LEGACY_SERVICE_LABEL = "thehive" as const;
export const LEGACY_SYSTEMD_UNIT_NAME = "thehive.service" as const;
export const LEGACY_WINDOWS_TASK_NAME = "thehive" as const;

export interface ServiceEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly execPath: string;
}

export interface ServicePlan {
  readonly platform: ServicePlatform;
  readonly manager: ServiceManager;
  readonly unitPath: string;
  readonly label: string;
  readonly execPath: string;
  readonly home: string;
}

export function resolveServiceContext(execPath: string): ServiceEnvironment {
  return {
    platform: process.platform,
    home: homedir(),
    execPath
  };
}

export function normalizePlatform(platform: NodeJS.Platform): ServicePlatform | null {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  return null;
}

function unitPathFor(plan: { platform: ServicePlatform; home: string }): string {
  switch (plan.platform) {
    case "darwin":
      return `${plan.home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
    case "linux":
      return `${plan.home}/.config/systemd/user/${SYSTEMD_UNIT_NAME}`;
    case "win32":
      return "";
  }
}

/**
 * The on-disk unit path the PRE-decision-#32 install would have used for this
 * plan's platform. Install removes it (best-effort) so a re-run migrates a
 * legacy unit instead of leaving two units racing over one daemon. Empty when
 * the platform keeps no unit file (Windows).
 */
export function legacyUnitPath(plan: ServicePlan): string {
  switch (plan.platform) {
    case "darwin":
      return `${plan.home}/Library/LaunchAgents/${LEGACY_SERVICE_LABEL}.plist`;
    case "linux":
      return `${plan.home}/.config/systemd/user/${LEGACY_SYSTEMD_UNIT_NAME}`;
    case "win32":
      return "";
  }
}

export function resolveServicePlan(environment: ServiceEnvironment): ServicePlan {
  const platform = normalizePlatform(environment.platform);
  if (platform === null) {
    throw new Error(`unsupported platform: ${environment.platform}`);
  }

  const manager: ServiceManager = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "schtasks";
  return {
    platform,
    manager,
    unitPath: unitPathFor({ platform, home: environment.home }),
    label: SERVICE_LABEL,
    execPath: environment.execPath,
    home: environment.home
  };
}
