/**
 * PRD-009a: fleet detection from LOCAL evidence, without requiring doctor (is-AC-1/2).
 *
 * fleet-status alone cannot answer "is doctor installed" pre-doctor (it depends on doctor's status
 * page being reachable), so detection derives each product's state from local evidence only:
 *   1. in-memory install state (an in-progress or failed install the daemon is tracking), then
 *   2. the presence + version of the package under the global node_modules directory.
 * hive is always installed (it is the daemon answering this request), reported at its own version.
 * Nothing here is taken from the request.
 */

import type {
  DetectResponse,
  ProductDetection,
  ProductSlug
} from "../../shared/onboarding-types.js";
import { z } from "zod";

import type { InstallerConfig } from "./config.js";
import { globalNodeModulesDir } from "./bin-resolver.js";
import { PRODUCT_PACKAGES, PRODUCT_SLUGS } from "./products.js";
import { isInstallableProduct } from "./products.js";
import type { InstallStateStore } from "./install-state.js";
import { join } from "node:path";

const InstalledPackageSchema = z.object({ version: z.string().optional() });

/** Read the installed version of `packageName` from its global node_modules package.json, if present. */
function readInstalledVersion(config: InstallerConfig, nodeModulesDir: string, packageName: string): string | undefined {
  let raw: string | null = null;
  try {
    raw = config.readTextFile(join(nodeModulesDir, packageName, "package.json"));
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const parsed = InstalledPackageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.version : undefined;
  } catch {
    return undefined;
  }
}

function detectFromBinEvidence(
  config: InstallerConfig,
  nodeModulesDir: string | null,
  slug: ProductSlug
): ProductDetection {
  if (nodeModulesDir === null) return { state: "not_installed" };
  const version = readInstalledVersion(config, nodeModulesDir, PRODUCT_PACKAGES[slug]);
  return version === undefined ? { state: "not_installed" } : { state: "installed", version };
}

function detectProduct(
  config: InstallerConfig,
  store: InstallStateStore,
  nodeModulesDir: string | null,
  slug: ProductSlug
): ProductDetection {
  // hive is the running daemon: authoritative, and never a portal install target.
  if (slug === "hive") return { state: "installed", version: config.hiveVersion };

  // An in-flight or failed install the daemon is actively tracking wins over on-disk evidence.
  if (isInstallableProduct(slug)) {
    const snapshot = store.detectState(slug);
    if (snapshot.status === "in_progress") return { state: "install_in_progress" };
    if (snapshot.status === "failed") {
      return snapshot.error === undefined
        ? { state: "install_failed" }
        : { state: "install_failed", error: snapshot.error };
    }
  }

  return detectFromBinEvidence(config, nodeModulesDir, slug);
}

/**
 * The installed version of a single product from the global node_modules, or `undefined` when it is
 * not installed. Used by the install endpoint's pinned-version short-circuit (is-AC-15).
 */
export async function installedVersion(config: InstallerConfig, slug: ProductSlug): Promise<string | undefined> {
  const prefix = await config.resolveNpmPrefix();
  if (prefix === null) return undefined;
  return readInstalledVersion(config, globalNodeModulesDir(prefix, config.platform), PRODUCT_PACKAGES[slug]);
}

/** Produce the full per-product detection map (is-AC-1/2). */
export async function detectFleet(config: InstallerConfig, store: InstallStateStore): Promise<DetectResponse> {
  const prefix = await config.resolveNpmPrefix();
  const nodeModulesDir = prefix === null ? null : globalNodeModulesDir(prefix, config.platform);

  const products = {} as Record<ProductSlug, ProductDetection>;
  for (const slug of PRODUCT_SLUGS) {
    try {
      products[slug] = detectProduct(config, store, nodeModulesDir, slug);
    } catch {
      // A read/decode error for one product never drops that product or its siblings from the map.
      products[slug] = { state: "not_installed" };
    }
  }
  return { products };
}
