/**
 * PRD-009a: the LOCKED API contract for the `/api/onboarding/*` installer surface.
 *
 * These types are the single shared contract between the daemon-side installer service
 * (`src/daemon/installer/`) and the onboarding UI (`src/dashboard/web/onboarding/`, owned by
 * PRD-009b). The UI builds against this exact shape, so any change here is a contract change.
 *
 * Nothing in this module reaches persistence: the installer's only durable artifact is the
 * one-time onboarding token file, and even that is out of band from these wire types.
 */

import type { FleetStatusResponse } from "./fleet-readiness.js";

/** The four fleet product slugs (is-AC-3). The install allowlist is derived from this closed set. */
export type ProductSlug = "honeycomb" | "doctor" | "hive" | "nectar";

/** The canonical runtime product list used by detect/onboarding contract code paths. */
export const PRODUCT_SLUGS = ["honeycomb", "doctor", "hive", "nectar"] as const;

/**
 * The three installable-via-portal products. `hive` is intentionally excluded: it is the daemon
 * serving this very endpoint, so it is never a portal install target (a request for it is a 400).
 */
export type InstallableProduct = "doctor" | "honeycomb" | "nectar";

/** The canonical installable product order for onboarding flows. */
export const INSTALLABLE_PRODUCTS = ["doctor", "honeycomb", "nectar"] as const;

/** The closed set of install stages streamed over SSE (is-AC-11). Never a percentage (is-AC-12). */
export type InstallStage =
  | "resolving"
  | "downloading"
  | "linking"
  | "registering_service"
  | "completed"
  | "failed";

/** The closed detection state set for a product (is-AC-2). */
export type ProductDetectionState = "not_installed" | "installed" | "install_in_progress" | "install_failed";

/** A bounded, truthful failure record: the stage it failed at plus a summary (is-AC-17). */
export interface InstallError {
  readonly stage: InstallStage;
  readonly summary: string;
}

/** One product's detection result: its state, the installed version when known, and any last error. */
export interface ProductDetection {
  readonly state: ProductDetectionState;
  readonly version?: string;
  readonly error?: InstallError;
}

/** `GET /api/onboarding/detect` -> the per-product detection map (is-AC-1/2). */
export interface DetectResponse {
  readonly products: Record<ProductSlug, ProductDetection>;
}

/** `POST /api/onboarding/install` body. Only the product slug crosses the wire (is-AC-4). */
export interface InstallRequest {
  readonly product: InstallableProduct;
}

/** `POST /api/onboarding/install` -> 202 when an install was started (or attached to). */
export interface InstallAcceptedResponse {
  readonly product: InstallableProduct;
  readonly state: "install_in_progress";
}

/** `POST /api/onboarding/install` -> 200 short-circuit when already installed at the pinned version (is-AC-15). */
export interface InstallShortCircuitResponse {
  readonly product: InstallableProduct;
  readonly state: "installed";
}

export type InstallResponse = InstallAcceptedResponse | InstallShortCircuitResponse;

/**
 * `POST /api/onboarding/install` -> 409 refusal (is-AC-5). `unpublished`: the manifest marks the
 * product `published:false`. `manifest_unresolved`: neither the network manifest nor the bundled
 * snapshot yields a shape-valid `packageName@version`. Never a fall-through to `@latest`.
 */
export interface InstallRefusalResponse {
  readonly error: "unpublished" | "manifest_unresolved";
}

/** One SSE progress frame (is-AC-11). `detail` is an optional bounded human string, never a percent. */
export interface ProgressEvent {
  readonly stage: InstallStage;
  readonly detail?: string;
}

/** `GET /api/onboarding/health` -> the fleet readiness projection reused from fleet-status (is-AC-18). */
export interface HealthResponse {
  readonly ready: boolean;
  readonly status: FleetStatusResponse;
}

/**
 * `POST /api/onboarding/event` body: a funnel event name plus optional flat string properties.
 * The daemon validates the token and records the call; wiring it to telemetry emission is Wave 2
 * (PRD-009c), so nothing is emitted here yet.
 */
export interface OnboardingEventRequest {
  readonly event: string;
  readonly properties?: Record<string, string>;
}
