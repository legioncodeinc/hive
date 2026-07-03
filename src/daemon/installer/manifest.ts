/**
 * PRD-009a: server-side `packageName@version` resolution from the fleet manifest (is-AC-4/5).
 *
 * The install target is NEVER taken from the request. It is resolved from `hive-release.json`:
 * fetched once per daemon session from the raw URL (bounded timeout), cached in memory, with a
 * build-time bundled snapshot as the offline fallback. Before any resolved value is used it must
 * pass a strict shape check (scoped-npm-name regex + semver regex, mirroring install.sh's
 * `npm_package_name_is_safe` / `semver_is_safe`), so a malformed or tampered field is refused
 * (is-AC-5) rather than degrading into an unpinned `npm i -g <name>@latest`.
 *
 * The imported snapshot is the SHIP-TIME manifest: the version set the running hive shipped with.
 * It is only consulted when the network fetch fails, so an offline-ish first run still pins.
 */

import { z } from "zod";

import type { InstallableProduct } from "../../shared/onboarding-types.js";
import type { InstallerConfig } from "./config.js";
// The ship-time snapshot fallback (is-AC-5). Comment-free JSON copied from the superproject
// `hive-release.json`; consulted only when the network manifest fetch fails.
import manifestSnapshot from "./manifest-snapshot.json" with { type: "json" };

/** A conservative npm package-name allowlist (lowercase / digits / `.` `_` `-`, optional `@scope/`). */
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** digits.digits.digits with an optional `-prerelease` / `+build` drawn from a safe charset. */
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/;

const ProductEntrySchema = z.object({
  version: z.string(),
  packageName: z.string(),
  published: z.boolean()
});

const ManifestSchema = z.object({
  manifestVersion: z.string(),
  products: z.record(z.string(), ProductEntrySchema)
});

export type ParsedManifest = z.infer<typeof ManifestSchema>;

/** The outcome of resolving an install target for a product. */
export type TargetResolution =
  | { readonly kind: "ok"; readonly packageName: string; readonly version: string; readonly target: string }
  | { readonly kind: "unpublished" }
  | { readonly kind: "manifest_unresolved" };

/** The manifest resolver: a memoized manifest plus a per-product target resolver. */
export interface ManifestResolver {
  resolve(product: InstallableProduct): Promise<TargetResolution>;
}

function validateSnapshot(): ParsedManifest | null {
  const parsed = ManifestSchema.safeParse(manifestSnapshot);
  return parsed.success ? parsed.data : null;
}

async function fetchManifestFromUrl(config: InstallerConfig, url: string): Promise<ParsedManifest | null> {
  try {
    const response = await config.manifestFetch(url, {
      signal: AbortSignal.timeout(config.manifestTimeoutMs)
    });
    if (!response.ok) return null;

    let parsedJson: unknown;
    try {
      parsedJson = await response.json();
    } catch {
      return null;
    }

    const parsed = ManifestSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function fetchNetworkManifest(config: InstallerConfig): Promise<ParsedManifest | null> {
  const primary = await fetchManifestFromUrl(config, config.manifestUrl);
  if (primary !== null) return primary;
  if (config.manifestFallbackUrl !== config.manifestUrl) {
    const fallback = await fetchManifestFromUrl(config, config.manifestFallbackUrl);
    if (fallback !== null) return fallback;
  }
  return null;
}

/**
 * Build a session-scoped manifest resolver. The manifest is fetched at most once (memoized on the
 * first call); a network failure falls back to the bundled snapshot. Returns `manifest_unresolved`
 * only when neither source yields a shape-valid entry for the requested product.
 */
export function createManifestResolver(config: InstallerConfig): ManifestResolver {
  let manifestPromise: Promise<ParsedManifest | null> | null = null;

  const getManifest = (): Promise<ParsedManifest | null> => {
    if (manifestPromise === null) {
      manifestPromise = fetchNetworkManifest(config).then((network) => network ?? validateSnapshot());
    }
    return manifestPromise;
  };

  return {
    async resolve(product: InstallableProduct): Promise<TargetResolution> {
      const manifest = await getManifest();
      if (manifest === null) return { kind: "manifest_unresolved" };

      const entry = manifest.products[product];
      if (entry === undefined) return { kind: "manifest_unresolved" };

      // Refuse a tampered/malformed field rather than ever reaching npm with an unsafe target.
      if (!NPM_NAME_RE.test(entry.packageName) || !SEMVER_RE.test(entry.version)) {
        return { kind: "manifest_unresolved" };
      }
      if (!entry.published) return { kind: "unpublished" };

      return {
        kind: "ok",
        packageName: entry.packageName,
        version: entry.version,
        target: `${entry.packageName}@${entry.version}`
      };
    }
  };
}
