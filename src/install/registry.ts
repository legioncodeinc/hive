import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HONEYCOMB_HOME_DIR } from "../shared/constants.js";

export const HIVEDOCTOR_REGISTRY_PATH = join(HONEYCOMB_HOME_DIR, "hivedoctor.daemons.json");

export const THEHIVE_REGISTRY_NAME = "thehive" as const;
export const THEHIVE_REGISTRY_HEALTH_URL = "http://127.0.0.1:3853/health" as const;
export const THEHIVE_REGISTRY_PID_PATH = "~/.honeycomb/thehive.pid" as const;
export const THEHIVE_REGISTRY_PROBE_INTERVAL_MS = 30_000 as const;
export const THEHIVE_REGISTRY_STARTUP_GRACE_MS = 60_000 as const;
export const THEHIVE_REGISTRY_RESTART_GIVE_UP_THRESHOLD = 3 as const;
export const THEHIVE_REGISTRY_RESTART_COOLDOWN_MS = 5_000 as const;

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
      mkdirSync(path, { recursive: true });
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

export function buildThehiveRegistryEntry(): RegistryDaemonEntry {
  return {
    name: THEHIVE_REGISTRY_NAME,
    healthUrl: THEHIVE_REGISTRY_HEALTH_URL,
    pidPath: THEHIVE_REGISTRY_PID_PATH,
    probeIntervalMs: THEHIVE_REGISTRY_PROBE_INTERVAL_MS,
    startupGraceMs: THEHIVE_REGISTRY_STARTUP_GRACE_MS,
    restartGiveUpThreshold: THEHIVE_REGISTRY_RESTART_GIVE_UP_THRESHOLD,
    restartCooldownMs: THEHIVE_REGISTRY_RESTART_COOLDOWN_MS
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

export function registerThehiveWithHivedoctor(options: RegistryUpsertOptions = {}): RegistryUpsertResult {
  const registryPath = options.registryPath ?? HIVEDOCTOR_REGISTRY_PATH;
  const fs = options.fs ?? createNodeRegistryFs();
  const parsed = readRegistryDocument(registryPath, fs);
  const nextDaemons = [...parsed.daemons];
  const thehiveEntry = buildThehiveRegistryEntry();

  const index = nextDaemons.findIndex((entry) => entry["name"] === THEHIVE_REGISTRY_NAME);
  if (index >= 0) {
    nextDaemons[index] = { ...nextDaemons[index], ...thehiveEntry };
  } else {
    nextDaemons.push(thehiveEntry);
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
