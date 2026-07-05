/**
 * PRD-009a: the hard-coded product allowlist and per-product registration verbs (is-AC-3/13).
 *
 * This is the single source of truth for which slugs exist, their npm bin names, and the OWN
 * registration verb each product runs post-install, exactly as honeycomb's `install.sh` does today
 * (`doctor install-service`, `honeycomb install`, `nectar install`). The install endpoint only ever
 * acts on a slug present in {@link INSTALLABLE_PRODUCTS}; `hive` is deliberately absent (it is the
 * running daemon, never a portal install target).
 */

import {
  INSTALLABLE_PRODUCTS,
  PRODUCT_SLUGS,
  type InstallableProduct,
  type ProductSlug
} from "../../shared/onboarding-types.js";

export { INSTALLABLE_PRODUCTS, PRODUCT_SLUGS };

/**
 * The npm package name for each slug, used as LOCAL DETECTION evidence (the folder name under the
 * global node_modules). This is deliberately independent of the manifest so detection works before
 * any manifest is fetched (is-AC-1); the manifest remains the sole authority for INSTALL targets.
 */
export const PRODUCT_PACKAGES: Record<ProductSlug, string> = {
  honeycomb: "@legioncodeinc/honeycomb",
  doctor: "@legioncodeinc/doctor",
  hive: "@legioncodeinc/hive",
  nectar: "@legioncodeinc/nectar"
};

/** Per-product static facts: the npm bin name and the argv of its own post-install registration verb. */
export interface ProductProfile {
  /** The npm bin name (equals the slug for every fleet product). */
  readonly binName: string;
  /** The registration verb argv run after a successful npm install (is-AC-13). */
  readonly registrationVerb: readonly string[];
}

const PROFILES: Record<InstallableProduct, ProductProfile> = {
  doctor: { binName: "doctor", registrationVerb: ["install-service"] },
  honeycomb: { binName: "honeycomb", registrationVerb: ["install"] },
  nectar: { binName: "nectar", registrationVerb: ["install"] }
};

/** True for one of the four known slugs (is-AC-3 allowlist membership). */
export function isProductSlug(value: string): value is ProductSlug {
  return (PRODUCT_SLUGS as readonly string[]).includes(value);
}

/** True for a portal-installable product (`hive` is excluded). */
export function isInstallableProduct(value: string): value is InstallableProduct {
  return (INSTALLABLE_PRODUCTS as readonly string[]).includes(value);
}

/** The static profile (bin name + registration verb) for an installable product. */
export function productProfile(product: InstallableProduct): ProductProfile {
  return PROFILES[product];
}
