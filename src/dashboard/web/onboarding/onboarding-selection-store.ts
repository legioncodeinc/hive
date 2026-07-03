/**
 * Session-scoped memory of the product subset the operator chose (Standard = the whole fleet,
 * Advanced = exactly the checked products). PRD-009b ob-AC-16 resume honesty: without this, an
 * interrupted Advanced install resumes from `remainingProducts(detection)`, which is every
 * not-installed product, so a product the operator explicitly DESELECTED would be silently
 * reinstalled on re-entry. Persisting the choice lets `buildResumeQueue` exclude a not-installed
 * product the operator never asked for, while still resuming any product that is genuinely
 * mid-flight or failed (those are in-flight facts, not assumptions).
 *
 * Storage is `sessionStorage` (per browser session, cleared when the tab closes) and every access
 * is guarded: a missing `window`, a storage exception (private mode, quota, disabled), or a
 * malformed value all degrade to "no memory" rather than throwing into the onboarding flow.
 */
import { FIXED_PRODUCT_ORDER, isInstallableProduct, type InstallableProduct } from "./contracts.js";

const SELECTION_KEY = "hive-onboarding-selection";

function storage(): Storage | null {
	try {
		if (typeof window === "undefined") return null;
		return window.sessionStorage;
	} catch {
		return null;
	}
}

/** Persist the chosen installable subset (order-normalized to the fixed order, de-duplicated). */
export function persistSelection(selected: readonly InstallableProduct[]): void {
	const store = storage();
	if (store === null) return;
	const normalized = FIXED_PRODUCT_ORDER.filter((p) => selected.includes(p));
	try {
		store.setItem(SELECTION_KEY, JSON.stringify(normalized));
	} catch {
		// A storage write failure is non-fatal: resume simply falls back to the conservative path.
	}
}

/** Read the persisted subset, or null when nothing valid is stored. */
export function readSelection(): readonly InstallableProduct[] | null {
	const store = storage();
	if (store === null) return null;
	let raw: string | null;
	try {
		raw = store.getItem(SELECTION_KEY);
	} catch {
		return null;
	}
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const products = parsed.filter((v): v is InstallableProduct => typeof v === "string" && isInstallableProduct(v));
		return products.length > 0 ? FIXED_PRODUCT_ORDER.filter((p) => products.includes(p)) : null;
	} catch {
		return null;
	}
}

/** Drop the persisted subset (call when onboarding reaches a terminal state). */
export function clearSelection(): void {
	const store = storage();
	if (store === null) return;
	try {
		store.removeItem(SELECTION_KEY);
	} catch {
		// Non-fatal.
	}
}
