import { homedir } from "node:os";
import { join } from "node:path";

import type { FleetRootDeps } from "./apiary-root.js";

/**
 * Legacy-window path constants only. Each site carries the fleet ADR removal criterion:
 * delete when every supported install path ships the PRD-010 migration
 * (superproject `library/ledger/EXECUTION_LEDGER-apiary-state-root.md`).
 *
 * Do not use these as runtime defaults; resolve current paths through `apiary-root.ts`.
 */

function legacyHome(deps: FleetRootDeps = {}): string {
  return deps.home ?? homedir();
}

/** Legacy shared runtime dir (pre-fleet-root migration). */
export function resolveLegacyHoneycombHomeDir(deps: FleetRootDeps = {}): string {
  return join(legacyHome(deps), ".honeycomb");
}

/** Legacy hive state dir under the shared honeycomb runtime dir. */
export function resolveLegacyHiveStateDir(deps: FleetRootDeps = {}): string {
  return join(resolveLegacyHoneycombHomeDir(deps), "hive");
}

/** Legacy pid/lock lived at the honeycomb home root, not inside the hive subdir. */
export function resolveLegacyHivePidPath(deps: FleetRootDeps = {}): string {
  return join(resolveLegacyHoneycombHomeDir(deps), "hive.pid");
}

export function resolveLegacyHiveLockPath(deps: FleetRootDeps = {}): string {
  return join(resolveLegacyHoneycombHomeDir(deps), "hive.lock");
}

/** Legacy doctor registry file (write/read fallback during the compatibility window). */
export function resolveLegacyDoctorRegistryPath(deps: FleetRootDeps = {}): string {
  return join(resolveLegacyHoneycombHomeDir(deps), "doctor.daemons.json");
}

/** Legacy shared install-id (read fallback during the compatibility window). */
export function resolveLegacySharedInstallIdPath(deps: FleetRootDeps = {}): string {
  return join(resolveLegacyHoneycombHomeDir(deps), "install-id");
}

/** Legacy onboarding token path (read fallback until bootstrap mint moves). */
export function resolveLegacyOnboardingTokenPath(deps: FleetRootDeps = {}): string {
  return join(resolveLegacyHiveStateDir(deps), "onboarding-token");
}

/** Module-load defaults (production); prefer the resolvers in tests and injectable call sites. */
export const LEGACY_HONEYCOMB_HOME_DIR = resolveLegacyHoneycombHomeDir();
export const LEGACY_HIVE_STATE_DIR = resolveLegacyHiveStateDir();
export const LEGACY_HIVE_PID_PATH = resolveLegacyHivePidPath();
export const LEGACY_HIVE_LOCK_PATH = resolveLegacyHiveLockPath();
export const LEGACY_DOCTOR_REGISTRY_PATH = resolveLegacyDoctorRegistryPath();
export const LEGACY_SHARED_INSTALL_ID_PATH = resolveLegacySharedInstallIdPath();
export const LEGACY_ONBOARDING_TOKEN_PATH = resolveLegacyOnboardingTokenPath();
