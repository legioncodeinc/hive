/**
 * The `/onboarding` route's WIRE CONTRACT, PRD-009b, mirroring the daemon-side installer service
 * from PRD-009a (`src/daemon/installer/`). `src/shared/onboarding-types.ts` is being authored in
 * parallel by the daemon-side agent; these are LOCAL types matching that contract's field names
 * exactly (per the implementation brief), so a later integration pass can point imports at the
 * shared module without changing a single field name.
 *
 * Every schema mirrors the `wire.ts` convention: zod at the boundary, every field `.catch()`-
 * defaulted so a partial/malformed body degrades to a safe empty state rather than throwing into
 * React (the onboarding screen is the FIRST thing a new operator sees: it must never white-screen).
 */

import { z } from "zod";

import type { FleetHealth, FleetStatusResponse } from "../../../shared/fleet-readiness.js";
import {
	INSTALLABLE_PRODUCTS as SHARED_INSTALLABLE_PRODUCTS,
	PRODUCT_SLUGS as SHARED_PRODUCT_SLUGS,
} from "../../../shared/onboarding-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Product identity
// ─────────────────────────────────────────────────────────────────────────────

/** Every product the daemon reports detection for (hive is always present; it is the caller). */
export const ONBOARDING_PRODUCTS = SHARED_PRODUCT_SLUGS;
export type OnboardingProduct = (typeof ONBOARDING_PRODUCTS)[number];

/** The three INSTALLABLE products, in the fixed order the guided flow walks them (ob-AC-6). */
export const FIXED_PRODUCT_ORDER = SHARED_INSTALLABLE_PRODUCTS;
export type InstallableProduct = (typeof FIXED_PRODUCT_ORDER)[number];

export function isInstallableProduct(value: string): value is InstallableProduct {
	return (FIXED_PRODUCT_ORDER as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/onboarding/detect
// ─────────────────────────────────────────────────────────────────────────────

export const PRODUCT_INSTALL_STATES = ["not_installed", "installed", "install_in_progress", "install_failed"] as const;
export type ProductInstallState = (typeof PRODUCT_INSTALL_STATES)[number];

const ProductErrorSchema = z.object({
	stage: z.string().catch(""),
	summary: z.string().catch(""),
});
export type ProductInstallError = z.infer<typeof ProductErrorSchema>;

const ProductDetectionSchema = z.object({
	state: z.enum(PRODUCT_INSTALL_STATES).catch("not_installed"),
	version: z.string().optional(),
	error: ProductErrorSchema.optional(),
});
export type ProductDetection = z.infer<typeof ProductDetectionSchema>;

/** The safe default for a product the response omitted (never assume installed). */
export const DEFAULT_PRODUCT_DETECTION: ProductDetection = Object.freeze({ state: "not_installed" });

const DetectProductsInputSchema = z
	.object({
		honeycomb: ProductDetectionSchema.optional(),
		doctor: ProductDetectionSchema.optional(),
		hive: ProductDetectionSchema.optional(),
		nectar: ProductDetectionSchema.optional(),
	})
	.catch({});

type DetectProducts = Record<OnboardingProduct, ProductDetection>;

function normalizeDetectProducts(products: z.infer<typeof DetectProductsInputSchema>): DetectProducts {
	return {
		honeycomb: products.honeycomb ?? DEFAULT_PRODUCT_DETECTION,
		doctor: products.doctor ?? DEFAULT_PRODUCT_DETECTION,
		hive: products.hive ?? DEFAULT_PRODUCT_DETECTION,
		nectar: products.nectar ?? DEFAULT_PRODUCT_DETECTION,
	};
}

const DEFAULT_DETECT_PRODUCTS: DetectProducts = Object.freeze(normalizeDetectProducts({}));

// The wire response is normalized to all four products, even if a malformed/legacy payload omits keys.
export const DetectResponseSchema = z.object({
	products: DetectProductsInputSchema.transform((products) => normalizeDetectProducts(products)).catch(DEFAULT_DETECT_PRODUCTS),
});
export type DetectResponse = z.infer<typeof DetectResponseSchema>;

/** The honest "nothing detected yet" default (a fetch failure never fabricates an installed product). */
export const EMPTY_DETECTION: DetectResponse = Object.freeze({ products: DEFAULT_DETECT_PRODUCTS });

/** Read one product's detection from the normalized four-product map. */
export function detectionFor(detection: DetectResponse, product: OnboardingProduct): ProductDetection {
	return detection.products[product];
}

/** ob-AC-3, every one of the four products reports `installed`. */
export function isFleetFullyInstalled(detection: DetectResponse): boolean {
	return ONBOARDING_PRODUCTS.every((p) => detectionFor(detection, p).state === "installed");
}

/**
 * The remaining (not-yet-installed) installable products, in the FIXED order, the set both the
 * Standard flow (ob-AC-6, unfiltered) and the Advanced picker (ob-AC-7, pre-checked) start from.
 */
export function remainingProducts(detection: DetectResponse): readonly InstallableProduct[] {
	return FIXED_PRODUCT_ORDER.filter((p) => detectionFor(detection, p).state !== "installed");
}

/**
 * ob-AC-16/ob-AC-17, true when detection shows an install already under way or failed for one of
 * the remaining products, meaning a choice (Standard or Advanced) was already made in a prior
 * visit. The resumed queue is simply {@link remainingProducts} walked from the top: any product
 * already `installed` is filtered out, and the first remaining entry is exactly the one that was
 * mid-flight or failed (re-attached, never re-offered the hero/picker).
 */
export function hasResumableInstall(detection: DetectResponse): boolean {
	return remainingProducts(detection).some((p) => {
		const state = detectionFor(detection, p).state;
		return state === "install_in_progress" || state === "install_failed";
	});
}

/**
 * The queue to resume with (ob-AC-16), honoring the operator's original subset when it is known.
 * `remainingProducts` alone would reinstall a product the operator explicitly DESELECTED in the
 * Advanced picker, because the daemon has no server-side memory of that subset. When a persisted
 * selection exists (see onboarding-selection-store), the resume queue is the remaining products
 * intersected with it, so a deselected product is never silently reinstalled. When no selection is
 * persisted (a fresh browser, cleared storage), any product that is genuinely mid-flight or failed
 * is still resumed (an in-flight fact, not an assumption); a merely `not_installed` product with no
 * persisted intent is left out, so the flow never installs something the operator did not choose.
 */
export function buildResumeQueue(
	detection: DetectResponse,
	persistedSelection: readonly InstallableProduct[] | null,
): readonly InstallableProduct[] {
	const remaining = remainingProducts(detection);
	if (persistedSelection !== null) {
		return remaining.filter((p) => persistedSelection.includes(p));
	}
	return remaining.filter((p) => {
		const state = detectionFor(detection, p).state;
		return state === "install_in_progress" || state === "install_failed";
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/install
// ─────────────────────────────────────────────────────────────────────────────

export const InstallStartResponseSchema = z.object({
	product: z.enum(FIXED_PRODUCT_ORDER).catch("doctor"),
	state: z.enum(["install_in_progress", "installed"]).catch("install_in_progress"),
});
export type InstallStartResponse = z.infer<typeof InstallStartResponseSchema>;

/** `POST /api/onboarding/install` -> 409 refusal (is-AC-5). */
export const InstallRefusalResponseSchema = z.object({
	error: z.enum(["unpublished", "manifest_unresolved"]),
});
export type InstallRefusalResponse = z.infer<typeof InstallRefusalResponseSchema>;

export type InstallStartResult = InstallStartResponse | InstallRefusalResponse;

/** Honest operator copy for installer refusals (409), with the same retry affordance as other failures. */
export function installRefusalMessage(error: InstallRefusalResponse["error"]): string {
	if (error === "unpublished") {
		return "This product is not published to npm yet, so the installer will not pull it. Retry after the release train publishes the package.";
	}
	return "The fleet version manifest could not be resolved, so the installer does not know which package version to install. Retry after the manifest is available.";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/onboarding/install/:product/events (SSE)
// ─────────────────────────────────────────────────────────────────────────────

/** The four REAL, observable install stages plus the two terminal outcomes (ob-AC-9: never a percent). */
export const INSTALL_STAGES = ["resolving", "downloading", "linking", "registering_service", "completed", "failed"] as const;
export type InstallStage = (typeof INSTALL_STAGES)[number];

/** The four IN-FLIGHT stages, in display order (excludes the two terminal outcomes). */
export const IN_FLIGHT_STAGES = ["resolving", "downloading", "linking", "registering_service"] as const satisfies readonly InstallStage[];

export const InstallProgressEventSchema = z.object({
	stage: z.enum(INSTALL_STAGES).catch("resolving"),
	detail: z.string().optional(),
});
export type InstallProgressEvent = z.infer<typeof InstallProgressEventSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/onboarding/health
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthResponse {
	readonly ready: boolean;
	readonly status: FleetStatusResponse;
}

/** The honest "daemon unreachable" default a failed/malformed health read degrades to. */
export const UNREACHABLE_HEALTH: HealthResponse = Object.freeze({
	ready: false,
	status: { supervisor: "unreachable" as const, daemons: [] as const },
});

/**
 * Parse a `GET /api/onboarding/health` body leniently (mirrors `buzzing-screen.tsx`'s established
 * `as FleetStatusResponse` cast for this exact daemon-owned union, {@link FleetStatusResponse} is
 * a discriminated union keyed on `supervisor`, not a flat shape zod's object schemas model cleanly,
 * and the existing precedent already trusts the daemon's own `isFleetReady`-validated projection).
 */
export function parseHealthResponse(body: unknown): HealthResponse {
	if (typeof body !== "object" || body === null) return UNREACHABLE_HEALTH;
	const record = body as { ready?: unknown; status?: unknown };
	const ready = typeof record.ready === "boolean" ? record.ready : false;
	const status = isFleetStatusShaped(record.status) ? record.status : UNREACHABLE_HEALTH.status;
	return { ready, status };
}

function isFleetStatusShaped(value: unknown): value is FleetStatusResponse {
	if (typeof value !== "object" || value === null) return false;
	const supervisor = (value as { supervisor?: unknown }).supervisor;
	return supervisor === "reachable" || supervisor === "unreachable";
}

/** Re-exported so onboarding modules read the daemon health vocabulary from one place. */
export type { FleetHealth, FleetStatusResponse };

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/event, the UI funnel chokepoint (fire-and-forget, never awaited by callers)
// ─────────────────────────────────────────────────────────────────────────────

/** The exact UI-fired event names (product install + health events are daemon-side, never sent here). */
export const ONBOARDING_UI_EVENTS = [
	"onboarding_started",
	"mode_selected",
	"login_shown",
	"tenancy_shown",
	"tenancy_selected",
	"workspace_created",
	"dashboard_reached",
] as const;
export type OnboardingUiEvent = (typeof ONBOARDING_UI_EVENTS)[number];
