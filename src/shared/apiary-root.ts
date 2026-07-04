import { homedir, platform } from "node:os";
import { join, win32 } from "node:path";

/** Injectable seams for fleet-root resolution (hermetic tests mirror production env). */
export interface FleetRootDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

function envStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Canonical fleet root chain (ADR-0005 / superproject ADR-0003 "Resolved decisions"):
 * APIARY_HOME > Linux XDG_STATE_HOME/apiary (only when XDG is explicitly set) > <home>/.apiary.
 * Anchored on `home` (default `os.homedir()`); never reads `process.cwd()`.
 */
export function resolveFleetRoot(deps: FleetRootDeps = {}): string {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const plat = deps.platform ?? platform();

  // Env roots are honored only when ABSOLUTE (fleet security rule, 2026-07-04; the XDG Base
  // Directory spec also requires ignoring relative values). Honoring a relative value would
  // anchor the fleet root (and the registry pidPath derived from it) on process.cwd(), which
  // this resolver must never do. win32.isAbsolute accepts /x, \x, and C:\x, a strict superset
  // of the posix check, so a relative value is never mistaken for absolute on any host.
  const apiaryHome = envStr(env, "APIARY_HOME");
  if (apiaryHome !== undefined && win32.isAbsolute(apiaryHome)) {
    return apiaryHome;
  }

  if (plat === "linux") {
    const xdgStateHome = envStr(env, "XDG_STATE_HOME");
    if (xdgStateHome !== undefined && win32.isAbsolute(xdgStateHome)) {
      return join(xdgStateHome, "apiary");
    }
  }

  return join(home, ".apiary");
}

/** Per-product hive state directory: `<fleetRoot>/hive`. */
export function resolveHiveStateDir(deps: FleetRootDeps = {}): string {
  return join(resolveFleetRoot(deps), "hive");
}

/** Doctor-owned cross-daemon registry at the fleet root. */
export function resolveFleetRegistryPath(deps: FleetRootDeps = {}): string {
  return join(resolveFleetRoot(deps), "registry.json");
}

/** Fleet-root shared install id (doctor/installer-managed; hive read-only). */
export function resolveSharedInstallIdPath(deps: FleetRootDeps = {}): string {
  return join(resolveFleetRoot(deps), "install-id");
}

export function resolveHivePidPath(deps: FleetRootDeps = {}): string {
  return join(resolveHiveStateDir(deps), "hive.pid");
}

export function resolveHiveLockPath(deps: FleetRootDeps = {}): string {
  return join(resolveHiveStateDir(deps), "hive.lock");
}

export function resolveOnboardingTokenPath(deps: FleetRootDeps = {}): string {
  return join(resolveHiveStateDir(deps), "onboarding-token");
}

export function resolveStagedWindowsTaskPath(deps: FleetRootDeps = {}): string {
  return join(resolveHiveStateDir(deps), "hive-task.xml");
}

export function resolveLaunchdLogPaths(deps: FleetRootDeps = {}): { readonly out: string; readonly err: string } {
  const stateDir = resolveHiveStateDir(deps);
  return {
    out: join(stateDir, "launchd.out.log"),
    err: join(stateDir, "launchd.err.log")
  };
}

/** Absolute pidPath written into hive's registry entry (ADR Resolved decision 4). */
export function resolveHiveRegistryPidPath(deps: FleetRootDeps = {}): string {
  return resolveHivePidPath(deps);
}
