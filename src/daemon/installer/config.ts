/**
 * PRD-009a: the installer service's injectable configuration (its test seams).
 *
 * Every side effect the installer performs, the manifest fetch, filesystem reads, the token file,
 * child-process spawns, npm-prefix resolution, and the clock, is reached through this object, so a
 * test never hits the network, real npm, or the real filesystem (mirroring how `fleet-status.ts`
 * takes a `FetchImpl`). Production defaults are assembled by {@link createInstallerConfig}.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { platform as osPlatform } from "node:process";

import { HIVE_VERSION, HONEYCOMB_HOME_DIR } from "../../shared/constants.js";
import { createNodeSpawn, type SpawnFn } from "./spawn.js";

/** The primary fleet manifest URL served by the install site (MV-2). */
export const MANIFEST_URL = "https://get.theapiary.sh/hive-release.json" as const;

/**
 * Second-chance fallback when {@link MANIFEST_URL} is unreachable. The private GitHub raw URL may
 * 404 without auth; it is tried only after the primary fetch fails, before the bundled snapshot.
 */
export const MANIFEST_FALLBACK_URL =
  "https://raw.githubusercontent.com/legioncodeinc/the-apiary/main/hive-release.json" as const;

/** The bootstrap-minted one-time onboarding token file (mode 0600), read lazily per request (is-AC-9). */
export const ONBOARDING_TOKEN_PATH = join(HONEYCOMB_HOME_DIR, "hive", "onboarding-token");

/** The bounded timeout for the single network manifest fetch before falling back to the snapshot. */
export const MANIFEST_TIMEOUT_MS = 5000 as const;

/** The minimal fetch surface the manifest resolver needs (a mock in tests). */
export type ManifestFetch = (input: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

/** The full seam set. Every field is overridable; {@link createInstallerConfig} fills the rest. */
export interface InstallerConfig {
  /** The primary raw manifest URL fetched once per session (is-AC-4, MV-2). */
  readonly manifestUrl: string;
  /** Fallback manifest URL when the primary fetch fails (MV-2). */
  readonly manifestFallbackUrl: string;
  /** The manifest fetch implementation (defaults to the global `fetch`). */
  readonly manifestFetch: ManifestFetch;
  /** The bounded manifest-fetch timeout in ms. */
  readonly manifestTimeoutMs: number;
  /** The onboarding token file path (read lazily, deleted on completion). */
  readonly tokenPath: string;
  /** Existence check (a fake map in tests). */
  readonly fileExists: (path: string) => boolean;
  /** UTF-8 read returning `null` on any error (a fake map in tests). */
  readonly readTextFile: (path: string) => string | null;
  /** Best-effort delete used to invalidate the token (never throws). */
  readonly deleteFile: (path: string) => void;
  /** Resolve npm's global prefix (`npm prefix -g`), cached by the service. */
  readonly resolveNpmPrefix: () => Promise<string | null>;
  /** The OS platform, deciding global node_modules + bin path shape. */
  readonly platform: NodeJS.Platform;
  /** The argv-safe spawn seam (is-AC-6). */
  readonly spawn: SpawnFn;
  /** A `require.resolve`-style fallback for locating `npm/bin/npm-cli.js`; `null` when unresolvable. */
  readonly requireResolve: (specifier: string) => string | null;
  /** The clock (injected in tests). */
  readonly now: () => number;
  /** hive's own running version, the authoritative answer for hive detection. */
  readonly hiveVersion: string;
  /** The node executable used as the argv[0] for every spawn (`process.execPath`). */
  readonly execPath: string;
}

function defaultReadTextFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function defaultDeleteFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: a delete failure still leaves the in-memory invalidation flag set (see token.ts).
  }
}

function defaultRequireResolve(specifier: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Assemble the production {@link InstallerConfig}. `resolveNpmPrefix` is intentionally left to the
 * service (it needs the other seams and memoizes the result), so it is injected by the service
 * wiring rather than defaulted here; a test provides its own.
 */
export function createInstallerConfig(overrides: Partial<InstallerConfig> = {}): InstallerConfig {
  return {
    manifestUrl: overrides.manifestUrl ?? MANIFEST_URL,
    manifestFallbackUrl: overrides.manifestFallbackUrl ?? MANIFEST_FALLBACK_URL,
    manifestFetch: overrides.manifestFetch ?? ((input, init) => fetch(input, init)),
    manifestTimeoutMs: overrides.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS,
    tokenPath: overrides.tokenPath ?? ONBOARDING_TOKEN_PATH,
    fileExists: overrides.fileExists ?? ((path) => existsSync(path)),
    readTextFile: overrides.readTextFile ?? defaultReadTextFile,
    deleteFile: overrides.deleteFile ?? defaultDeleteFile,
    resolveNpmPrefix: overrides.resolveNpmPrefix ?? (async () => null),
    platform: overrides.platform ?? osPlatform,
    spawn: overrides.spawn ?? createNodeSpawn(),
    requireResolve: overrides.requireResolve ?? defaultRequireResolve,
    now: overrides.now ?? Date.now,
    hiveVersion: overrides.hiveVersion ?? HIVE_VERSION,
    execPath: overrides.execPath ?? process.execPath
  };
}
