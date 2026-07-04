import { existsSync, readFileSync } from "node:fs";

import { resolveFleetRegistryPath, resolveFleetRoot, type FleetRootDeps } from "./apiary-root.js";
import { resolveLegacyDoctorRegistryPath } from "./legacy-paths.js";

/**
 * Registry compatibility window (ADR-0005 Resolved decision 3):
 * write `<fleetRoot>/registry.json` when the fleet root directory exists, else legacy path; never both.
 */
export function resolveRegistryWritePath(deps: FleetRootDeps = {}): string {
  const fleetRoot = resolveFleetRoot(deps);
  if (existsSync(fleetRoot)) {
    return resolveFleetRegistryPath(deps);
  }
  return resolveLegacyDoctorRegistryPath(deps);
}

export interface ReadRegistryBodyOptions extends FleetRootDeps {
  /** Explicit override for tests (skips the new-then-legacy chain). */
  readonly registryPath?: string;
  readonly readFile?: (path: string) => string;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Read-side fallback chain (rc-AC-4/5/6, mg-AC-10): new path first, then legacy, then absent.
 * The legacy fallback is ABSENCE-triggered only (ENOENT): a new file that exists but cannot be
 * read (EACCES, EISDIR, corruption at the fs layer) yields `null` (callers degrade to defaults),
 * never stale legacy data, because when the new path exists the new file wins.
 */
export function readRegistryBody(options: ReadRegistryBodyOptions = {}): string | null {
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));

  if (options.registryPath !== undefined) {
    try {
      return readFile(options.registryPath);
    } catch {
      return null;
    }
  }

  const newPath = resolveFleetRegistryPath(options);
  try {
    return readFile(newPath);
  } catch (error) {
    // mg-AC-10: a present-but-unreadable new file must NOT surface legacy data.
    if (!isEnoent(error)) return null;
    // Legacy-window read fallback (new path absent); removal criterion in legacy-paths.ts.
    try {
      return readFile(resolveLegacyDoctorRegistryPath(options));
    } catch {
      return null;
    }
  }
}

export { resolveFleetRoot };
