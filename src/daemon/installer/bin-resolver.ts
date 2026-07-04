/**
 * PRD-009a: argv-safe resolution of the JS entry points the installer spawns (is-AC-6).
 *
 * npm and each product ship a `.cmd`/shell shim on the global `bin` path that cannot be spawned
 * with `shell:false` on Windows. Instead of ever touching those shims, we resolve the underlying
 * `*.js` entry from the package's own `package.json#bin` field and spawn it as
 * `process.execPath [entry.js, ...args]`. No `.cmd`, no shell, anywhere.
 *
 * Layout facts:
 *   - global node_modules: `<prefix>/lib/node_modules` (POSIX) or `<prefix>/node_modules` (Windows)
 *   - npm's own entry: `npm/bin/npm-cli.js` inside global node_modules (or a require.resolve fallback)
 *   - node ships npm next to the executable, so npm-cli.js is locatable relative to `process.execPath`
 *     even before we know the prefix (used to run `npm prefix -g` itself)
 */

import { dirname, join } from "node:path";
import { z } from "zod";

import type { InstallerConfig } from "./config.js";

/** The global node_modules directory for a resolved npm prefix, per platform. */
export function globalNodeModulesDir(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
}

/** npm's `bin` field can be a bare string or a `{ name: relPath }` map. */
const BinFieldSchema = z.union([z.string(), z.record(z.string(), z.string())]);
const PackageJsonBinSchema = z.object({ bin: BinFieldSchema.optional() });

/**
 * Resolve the absolute `*.js` entry for `binName` inside `<nodeModulesDir>/<packageName>`, reading
 * the package's `package.json#bin`. Returns `null` when the package, its manifest, or the bin entry
 * cannot be resolved (the caller treats that as a registration failure, is-AC-13).
 */
export function resolvePackageBinJs(
  config: InstallerConfig,
  nodeModulesDir: string,
  packageName: string,
  binName: string
): string | null {
  const packageDir = join(nodeModulesDir, packageName);
  const raw = config.readTextFile(join(packageDir, "package.json"));
  if (raw === null) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = PackageJsonBinSchema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.bin === undefined) return null;

  const bin = parsed.data.bin;
  const relEntry = typeof bin === "string" ? bin : bin[binName];
  if (relEntry === undefined || relEntry.length === 0) return null;

  const entry = join(packageDir, relEntry);
  return config.fileExists(entry) ? entry : null;
}

/**
 * Locate `npm/bin/npm-cli.js` relative to `process.execPath` (node ships npm beside its binary),
 * so we can run `npm prefix -g` before the prefix is known. Falls back to `require.resolve`.
 */
export function locateNpmCliJs(config: InstallerConfig): string | null {
  // FIRST CHOICE: the npm co-located with hive's own global install. `require.resolve` walks up
  // from this module (…/lib/node_modules/@legioncodeinc/hive/dist/…) into the SAME global
  // node_modules tree hive was installed into, so this npm manages the SAME prefix — products land
  // where the operator's PATH already finds hive. The execPath-relative candidates below are only
  // layout heuristics and can pick a DIFFERENT prefix (e.g. Homebrew's bundled npm under
  // libexec/ resolves `prefix -g` to the Cellar dir, silently installing products nowhere useful).
  //
  // npm's `exports` map exposes only `.` and `./package.json` — resolving `npm/bin/npm-cli.js`
  // directly throws ERR_PACKAGE_PATH_NOT_EXPORTED — so resolve the exported package.json and
  // derive the bin path from the package dir.
  const npmPackageJson = config.requireResolve("npm/package.json");
  if (npmPackageJson !== null) {
    const viaPackage = join(dirname(npmPackageJson), "bin", "npm-cli.js");
    if (config.fileExists(viaPackage)) return viaPackage;
  }

  const execDir = dirname(config.execPath);
  const candidates =
    config.platform === "win32"
      ? [join(execDir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [
          join(dirname(execDir), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          // Homebrew node: npm ships under `libexec/`, not `lib/`, beside the Cellar-versioned
          // binary (e.g. /opt/homebrew/Cellar/node/<ver>/libexec/lib/node_modules/npm).
          join(dirname(execDir), "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js")
        ];

  for (const candidate of candidates) {
    if (config.fileExists(candidate)) return candidate;
  }

  return config.requireResolve("npm/bin/npm-cli.js");
}

/**
 * The default `npm prefix -g` resolver: locate npm-cli.js relative to the node binary and spawn it
 * argv-safe, returning the trimmed prefix. Returns `null` when npm-cli.js cannot be located or the
 * command fails. The installer service memoizes this so it runs at most once per daemon session.
 */
export async function resolveNpmPrefixViaCli(config: InstallerConfig): Promise<string | null> {
  const npmCli = locateNpmCliJs(config);
  if (npmCli === null) return null;
  try {
    const outcome = await config.spawn(config.execPath, [npmCli, "prefix", "-g"]);
    if (outcome.code !== 0) return null;
    const prefix = outcome.stdoutTail.trim();
    return prefix.length > 0 ? prefix : null;
  } catch {
    return null;
  }
}
