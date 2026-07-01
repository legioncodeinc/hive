import { homedir } from "node:os";

export type ServicePlatform = "darwin" | "linux" | "win32";
export type ServiceManager = "launchd" | "systemd" | "schtasks";

export const SERVICE_LABEL = "thehive" as const;
export const SYSTEMD_UNIT_NAME = "thehive.service" as const;
export const WINDOWS_TASK_NAME = "thehive" as const;

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
