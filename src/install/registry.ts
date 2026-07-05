import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveFleetRegistryPath, resolveHiveRegistryPidPath } from "../shared/apiary-root.js";
import { resolveLegacyDoctorRegistryPath } from "../shared/legacy-paths.js";
import { resolveRegistryWritePath } from "../shared/registry-paths.js";

// NOTE: there is deliberately NO exported DOCTOR_REGISTRY_PATH constant on the write side.
// The write target is window-dependent (`resolveRegistryWritePath()` answers differently before
// and after the fleet root exists), so a module-load snapshot would hand future callers a stale
// answer. Use the re-exported `resolveRegistryWritePath` function (bottom of this module) instead.

export const HIVE_REGISTRY_NAME = "hive" as const;
export const HIVE_REGISTRY_HEALTH_URL = "http://127.0.0.1:3853/health" as const;
export const HIVE_REGISTRY_PID_PATH = resolveHiveRegistryPidPath();
export const HIVE_REGISTRY_PROBE_INTERVAL_MS = 30_000 as const;
export const HIVE_REGISTRY_STARTUP_GRACE_MS = 60_000 as const;
export const HIVE_REGISTRY_RESTART_GIVE_UP_THRESHOLD = 3 as const;
export const HIVE_REGISTRY_RESTART_COOLDOWN_MS = 5_000 as const;

export interface RegistryFs {
  readFile(path: string): string;
  mkdirp(path: string): void;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  removeFile(path: string): void;
}

export interface RegistryUpsertOptions {
  readonly registryPath?: string;
  readonly fs?: RegistryFs;
}

export interface RegistryUpsertResult {
  readonly registryPath: string;
  readonly updatedExistingEntry: boolean;
}

export type RegistryDaemonEntry = Record<string, unknown> & {
  readonly name: string;
  readonly healthUrl: string;
  readonly pidPath: string;
  readonly probeIntervalMs: number;
  readonly startupGraceMs: number;
  readonly restartGiveUpThreshold: number;
  readonly restartCooldownMs: number;
};

interface ParsedRegistryDocument {
  readonly root: Record<string, unknown>;
  readonly daemons: Array<Record<string, unknown>>;
}

export function createNodeRegistryFs(): RegistryFs {
  return {
    readFile(path: string): string {
      return readFileSync(path, "utf8");
    },
    mkdirp(path: string): void {
      // Match the 0o700 the state migration applies when it creates the fleet root, so whichever
      // writer creates the directory first the result is the same user-private mode.
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    writeFile(path: string, content: string): void {
      writeFileSync(path, content, "utf8");
    },
    rename(from: string, to: string): void {
      renameSync(from, to);
    },
    removeFile(path: string): void {
      rmSync(path, { force: true });
    }
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function parseRegistryDocument(raw: string): ParsedRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { root: {}, daemons: [] };
  }

  const root = asObject(parsed);
  if (root === null) return { root: {}, daemons: [] };

  const rawDaemons = root["daemons"];
  const daemons = Array.isArray(rawDaemons)
    ? rawDaemons
        .map((entry) => asObject(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];

  return { root, daemons };
}

export function buildHiveRegistryEntry(): RegistryDaemonEntry {
  return {
    name: HIVE_REGISTRY_NAME,
    healthUrl: HIVE_REGISTRY_HEALTH_URL,
    pidPath: resolveHiveRegistryPidPath(),
    probeIntervalMs: HIVE_REGISTRY_PROBE_INTERVAL_MS,
    startupGraceMs: HIVE_REGISTRY_STARTUP_GRACE_MS,
    restartGiveUpThreshold: HIVE_REGISTRY_RESTART_GIVE_UP_THRESHOLD,
    restartCooldownMs: HIVE_REGISTRY_RESTART_COOLDOWN_MS
  };
}

function readRegistryDocument(path: string, fs: RegistryFs): ParsedRegistryDocument {
  try {
    return parseRegistryDocument(fs.readFile(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { root: {}, daemons: [] };
    throw error;
  }
}

function nextTempPath(registryPath: string): string {
  return `${registryPath}.tmp-${process.pid}-${Date.now()}`;
}

export function registerHiveWithDoctor(options: RegistryUpsertOptions = {}): RegistryUpsertResult {
  const registryPath = options.registryPath ?? resolveRegistryWritePath();
  const fs = options.fs ?? createNodeRegistryFs();
  const parsed = readRegistryDocument(registryPath, fs);
  const nextDaemons = [...parsed.daemons];
  const hiveEntry = buildHiveRegistryEntry();

  const index = nextDaemons.findIndex((entry) => entry["name"] === HIVE_REGISTRY_NAME);
  if (index >= 0) {
    nextDaemons[index] = { ...nextDaemons[index], ...hiveEntry };
  } else {
    nextDaemons.push(hiveEntry);
  }

  const nextRoot: Record<string, unknown> = { ...parsed.root, daemons: nextDaemons };
  const serialized = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const tempPath = nextTempPath(registryPath);

  fs.mkdirp(dirname(registryPath));
  fs.writeFile(tempPath, serialized);
  try {
    fs.rename(tempPath, registryPath);
  } catch (error) {
    fs.removeFile(tempPath);
    throw error;
  }

  return {
    registryPath,
    updatedExistingEntry: index >= 0
  };
}

export interface RegistryDeleteResult {
  readonly removed: boolean;
  readonly registryPaths: readonly string[];
}

function registryHasHiveEntry(path: string, fs: RegistryFs): boolean {
  const parsed = readRegistryDocument(path, fs);
  return parsed.daemons.some((entry) => entry["name"] === HIVE_REGISTRY_NAME);
}

function deleteHiveEntryAtPath(path: string, fs: RegistryFs): boolean {
  let parsed: ParsedRegistryDocument;
  try {
    parsed = readRegistryDocument(path, fs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }

  const index = parsed.daemons.findIndex((entry) => entry["name"] === HIVE_REGISTRY_NAME);
  if (index < 0) return false;

  const nextDaemons = parsed.daemons.filter((_, entryIndex) => entryIndex !== index);
  const nextRoot: Record<string, unknown> = { ...parsed.root, daemons: nextDaemons };
  const serialized = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const tempPath = nextTempPath(path);

  fs.mkdirp(dirname(path));
  fs.writeFile(tempPath, serialized);
  try {
    fs.rename(tempPath, path);
  } catch (error) {
    fs.removeFile(tempPath);
    throw error;
  }

  return true;
}

export function deleteHiveFromDoctor(options: RegistryUpsertOptions = {}): RegistryDeleteResult {
  const fs = options.fs ?? createNodeRegistryFs();
  const explicitPath = options.registryPath;
  const candidatePaths =
    explicitPath !== undefined
      ? [explicitPath]
      : [resolveRegistryWritePath(), resolveFleetRegistryPath(), resolveLegacyDoctorRegistryPath()];

  const registryPaths: string[] = [];
  for (const path of [...new Set(candidatePaths)]) {
    if (deleteHiveEntryAtPath(path, fs)) registryPaths.push(path);
  }

  return {
    removed: registryPaths.length > 0,
    registryPaths
  };
}

export function registryContainsHiveEntry(options: RegistryUpsertOptions = {}): boolean {
  const fs = options.fs ?? createNodeRegistryFs();
  const explicitPath = options.registryPath;
  const candidatePaths =
    explicitPath !== undefined
      ? [explicitPath]
      : [resolveRegistryWritePath(), resolveFleetRegistryPath(), resolveLegacyDoctorRegistryPath()];

  for (const path of [...new Set(candidatePaths)]) {
    try {
      if (registryHasHiveEntry(path, fs)) return true;
    } catch {
      // Unreadable registry files are treated as absent for uninstall no-op detection.
    }
  }
  return false;
}

export { resolveRegistryWritePath } from "../shared/registry-paths.js";
