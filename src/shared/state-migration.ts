import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";

import { resolveHiveStateDir, type FleetRootDeps } from "./apiary-root.js";
import { resolveLegacyHiveStateDir } from "./legacy-paths.js";

/** Hive-owned state files copied from the legacy state dir (not pid/lock or launchd logs). */
const MIGRATABLE_STATE_FILENAMES = [
  "install-id",
  "telemetry.json",
  "onboarding-telemetry.json",
  "hive-task.xml",
  "onboarding-token"
] as const;

export interface MigrateHiveStateResult {
  readonly migratedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
  readonly errors: readonly string[];
}

function filesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

function copyVerified(source: string, dest: string): void {
  copyFileSync(source, dest);
  if (!filesEqual(source, dest)) {
    rmSync(dest, { force: true });
    throw new Error(`verify failed after copy: ${dest}`);
  }
}

function migrateOneFile(
  legacyDir: string,
  newDir: string,
  filename: string
): "migrated" | "skipped" | "absent" | "error" {
  const source = `${legacyDir}/${filename}`;
  const dest = `${newDir}/${filename}`;
  if (!existsSync(source)) return "absent";
  if (existsSync(dest)) return "skipped";

  try {
    copyVerified(source, dest);
    rmSync(source, { force: true });
    return "migrated";
  } catch {
    return "error";
  }
}

/**
 * One-time, idempotent, additive migration of hive-owned state (PRD-010b).
 * Fail-soft: never throws; legacy originals remain when copy fails (mg-AC-3).
 */
export function migrateHiveState(deps: FleetRootDeps = {}): MigrateHiveStateResult {
  const newDir = resolveHiveStateDir(deps);
  const legacyDir = resolveLegacyHiveStateDir(deps);
  const migratedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const errors: string[] = [];

  const legacyStatePresent = existsSync(legacyDir);
  if (!legacyStatePresent) {
    try {
      mkdirSync(newDir, { recursive: true, mode: 0o700 });
    } catch {
      // Best effort; lock acquisition will retry mkdir.
    }
    return { migratedFiles, skippedFiles, errors };
  }

  try {
    mkdirSync(newDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "mkdir failed");
    return { migratedFiles, skippedFiles, errors };
  }

  for (const filename of MIGRATABLE_STATE_FILENAMES) {
    const outcome = migrateOneFile(legacyDir, newDir, filename);
    switch (outcome) {
      case "migrated":
        migratedFiles.push(filename);
        break;
      case "skipped":
        skippedFiles.push(filename);
        break;
      case "error":
        errors.push(filename);
        break;
      case "absent":
        break;
    }
  }

  return { migratedFiles, skippedFiles, errors };
}

/** Best-effort ensure the new hive state dir exists with mode 0o700 (mg-AC-4). */
export function ensureHiveStateDir(deps: FleetRootDeps = {}): void {
  try {
    mkdirSync(resolveHiveStateDir(deps), { recursive: true, mode: 0o700 });
  } catch {
    // Fail-soft; callers that require the dir will surface errors later.
  }
}
