/**
 * The onboarding CONTENT layer, PRD-009b ob-AC-8/ob-AC-10. Per-product benefit copy (drafted from
 * each sibling repo's README voice: `honeycomb/README.md`, `doctor/README.md`, `nectar/README.md`)
 * plus the npm-safety reassurance every install card carries and the Doctor-deselect warning the
 * Advanced picker shows (ob-AC-7). Kept as data, not JSX, so copy review never touches a component.
 */

import type { InstallableProduct, OnboardingProduct } from "./contracts.js";

export interface ProductCopy {
	readonly title: string;
	/** A punchy, honest headline (drafted from the product's README hero line). */
	readonly headline: string;
	/** Two short supporting lines, concrete, no invented claims. */
	readonly lines: readonly [string, string];
	/** Doctor carries the `Recommended` badge in the Advanced picker (ob-AC-7). */
	readonly recommended: boolean;
}

/**
 * Drafted verbatim from each product's README (see the task report for the source lines this
 * copy distills): Doctor's "watchdog that keeps your agents' brain alive" + repair-ladder pitch,
 * Honeycomb's "shared, persistent memory" + skillify/propagation pitch, Nectar's "stable identity
 * that survives refactors" + the fourth-recall-arm pitch. Honest and concrete, no invented claims.
 */
export const PRODUCT_COPY: Record<InstallableProduct, ProductCopy> = {
	doctor: {
		title: "Doctor",
		headline: "Doctor keeps your daemons alive while you are not looking.",
		lines: [
			"Restarts a crashed daemon, then climbs an escalating repair ladder if a plain restart is not enough.",
			"Runs OS-supervised so it starts on boot and survives its own crashes too.",
		],
		recommended: true,
	},
	honeycomb: {
		title: "Honeycomb",
		headline: "Honeycomb is the shared memory your agents keep across sessions.",
		lines: [
			"Captures what happens on every turn and recalls it in any harness, on any machine.",
			"Mines reusable skills from real sessions and propagates them to your whole team automatically.",
		],
		recommended: false,
	},
	nectar: {
		title: "Nectar",
		headline: "Nectar gives every file in your repo an identity that survives refactors.",
		lines: [
			"Tracks files through renames and moves, so memory tied to an old path never goes stale.",
			"Feeds Honeycomb's recall a fourth arm, so asking where the login logic lives actually works.",
		],
		recommended: false,
	},
};

/**
 * ob-AC-10, the npm-safety reassurance every install card carries, verbatim. Checkably true for
 * all four packages (`@legioncodeinc/{honeycomb,doctor,hive,nectar}` each publish with npm Trusted
 * Publishing OIDC provenance per the parent PRD's overview), so this never overstates the claim.
 */
export const NPM_SAFETY_COPY =
	"Installed straight from the public npm registry. Every package here is signed and provenance verified through npm Trusted Publishing (OIDC), so what installs is exactly what we published.";

/** ob-AC-7, shown when Doctor is deselected in the Advanced picker. */
export const DOCTOR_DESELECT_WARNING = "Without Doctor, nothing restarts your daemons after a crash or reboot.";

/**
 * Resolve a product's brand mark URL. Honeycomb keeps its existing top-level, `assetBase`-relative
 * route (`host.ts`'s `DASHBOARD_LOGO_PATH`, unchanged by this PRD); Doctor, Hive, and Nectar are
 * served by the daemon agent at the new fixed `/assets/brand/<name>-mark.svg` route (see the task
 * brief), independent of `assetBase`.
 */
export function productLogoUrl(product: OnboardingProduct, assetBase: string): string {
	if (product === "honeycomb") return `${assetBase}/honeycomb-memory-cluster.svg`;
	return `/assets/brand/${product}-mark.svg`;
}

/** The install-stage vocabulary (ob-AC-9): a short human label per stage, never a percentage. */
export const INSTALL_STAGE_LABEL: Record<
	"resolving" | "downloading" | "linking" | "registering_service" | "completed" | "failed",
	string
> = {
	resolving: "Resolving the package",
	downloading: "Downloading from npm",
	linking: "Linking the binary",
	registering_service: "Registering the service",
	completed: "Installed",
	failed: "Installation failed",
};
