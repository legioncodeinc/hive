import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  withLock?<T>(registryPath: string, operation: () => T): T;
}

export interface RegistryUpsertOptions {
  readonly registryPath?: string;
  readonly fs?: RegistryFs;
}

export interface RegistryUpsertResult {
  readonly registryPath: string;
  readonly updatedExistingEntry: boolean;
}

export class RegistryDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryDocumentError";
  }
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
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, content, "utf8");
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    },
    rename(from: string, to: string): void {
      renameSync(from, to);
    },
    removeFile(path: string): void {
      rmSync(path, { force: true });
    },
    withLock<T>(registryPath: string, operation: () => T): T {
      const lockPath = `${registryPath}.lock`;
      const deadline = Date.now() + 2_000;
      const owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
      const ownerText = JSON.stringify(owner);
      let fd: number | undefined;
      while (fd === undefined) {
        try {
          fd = openSync(lockPath, "wx", 0o600);
          try {
            writeFileSync(fd, ownerText, "utf8");
            fchmodSync(fd, 0o600);
          } catch (error) {
            closeSync(fd);
            fd = undefined;
            rmSync(lockPath, { force: true });
            throw error;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const observed = readFileSync(lockPath, "utf8");
            const stat = lstatSync(lockPath);
            if (Date.now() - stat.mtimeMs > 30_000 && lockOwnerIsDeadOrInvalid(observed)) {
              // Recheck the owner token immediately before unlinking so a successor lock is not
              // removed merely because this contender originally observed a stale predecessor.
              if (readFileSync(lockPath, "utf8") === observed) rmSync(lockPath, { force: true });
              continue;
            }
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw statError;
          }
          if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for Doctor registry lock at ${lockPath}.`);
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      try {
        return operation();
      } finally {
        closeSync(fd);
        try {
          if (readFileSync(lockPath, "utf8") === ownerText) rmSync(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  };
}

function lockOwnerIsDeadOrInvalid(raw: string): boolean {
  let pid: number;
  try {
    const parsed: unknown = JSON.parse(raw);
    const candidate = (parsed as { pid?: unknown } | null)?.pid;
    if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) return true;
    pid = candidate as number;
  } catch {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function parseRegistryDocument(raw: string): ParsedRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryDocumentError(`Doctor registry contains invalid JSON: ${error instanceof Error ? error.message : "parse failed"}.`);
  }

  const root = asObject(parsed);
  if (root === null) throw new RegistryDocumentError("Doctor registry root must be a JSON object.");

  const rawDaemons = root["daemons"];
  if (rawDaemons !== undefined && !Array.isArray(rawDaemons)) {
    throw new RegistryDocumentError("Doctor registry daemons field must be an array.");
  }
  const daemons: Array<Record<string, unknown>> = [];
  for (const entry of rawDaemons ?? []) {
    const object = asObject(entry);
    if (object === null) throw new RegistryDocumentError("Doctor registry daemon entries must be objects.");
    daemons.push(object);
  }

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
  return `${registryPath}.tmp-${process.pid}-${randomUUID()}`;
}

function withRegistryLock<T>(path: string, fs: RegistryFs, operation: () => T): T {
  return fs.withLock === undefined ? operation() : fs.withLock(path, operation);
}

export function registerHiveWithDoctor(options: RegistryUpsertOptions = {}): RegistryUpsertResult {
  const registryPath = options.registryPath ?? resolveRegistryWritePath();
  const fs = options.fs ?? createNodeRegistryFs();
  fs.mkdirp(dirname(registryPath));
  return withRegistryLock(registryPath, fs, () => {
    const parsed = readRegistryDocument(registryPath, fs);
    const nextDaemons = [...parsed.daemons];
    const hiveEntry = buildHiveRegistryEntry();
    const index = nextDaemons.findIndex((entry) => entry["name"] === HIVE_REGISTRY_NAME);
    if (index >= 0) nextDaemons[index] = { ...nextDaemons[index], ...hiveEntry };
    else nextDaemons.push(hiveEntry);

    const serialized = `${JSON.stringify({ ...parsed.root, daemons: nextDaemons }, null, 2)}\n`;
    const tempPath = nextTempPath(registryPath);
    fs.writeFile(tempPath, serialized);
    try {
      fs.rename(tempPath, registryPath);
    } catch (error) {
      fs.removeFile(tempPath);
      throw error;
    }
    return { registryPath, updatedExistingEntry: index >= 0 };
  });
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
  fs.mkdirp(dirname(path));
  return withRegistryLock(path, fs, () => {
    const parsed = readRegistryDocument(path, fs);
    const index = parsed.daemons.findIndex((entry) => entry["name"] === HIVE_REGISTRY_NAME);
    if (index < 0) return false;
    const nextDaemons = parsed.daemons.filter((_, entryIndex) => entryIndex !== index);
    const serialized = `${JSON.stringify({ ...parsed.root, daemons: nextDaemons }, null, 2)}\n`;
    const tempPath = nextTempPath(path);
    fs.writeFile(tempPath, serialized);
    try {
      fs.rename(tempPath, path);
    } catch (error) {
      fs.removeFile(tempPath);
      throw error;
    }
    return true;
  });
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
