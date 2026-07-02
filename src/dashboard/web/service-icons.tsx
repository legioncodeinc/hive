/**
 * The bee-related status SVG set + the single shared state→icon mapping — hive PRD-004b.
 *
 * Five distinct bee-motif icons, one per locked {@link ServiceState} (`error`, `degraded`,
 * `starting`, `warming`, `active`), plus a fail-safe fallback for any unexpected value (svg-AC-5).
 * Every icon differs in SHAPE/MOTIF, not only color (svg-AC-2), so the set reads in grayscale and
 * for color-vision-deficient operators:
 *
 *   - `starting` — an empty honeycomb CELL outline (not yet emerged; no bee drawn at all).
 *   - `warming`  — a bee body with small, half-folded wings (just emerged, wings unfurling).
 *   - `active`   — a bee body with full, wide-spread wings (settled and flying).
 *   - `degraded` — a bee body with ONE wing only (asymmetric) plus a small caution mark.
 *   - `error`    — a bee body lying on its back (rotated) with its wings crossed into an X.
 *
 * {@link ServiceStateIcon} is the ONE shared resolver every consumer (`/buzzing` tiles, PRD-004a;
 * the health rail pills, PRD-005a) renders through (svg-AC-4), so a state means the same icon
 * everywhere. Every stroke/fill uses `currentColor` (dark-mode legible, svg-AC-3) with color used
 * only as reinforcement — never the sole differentiator (svg-AC-2).
 */

import React from "react";

import { isServiceState, type ServiceState } from "../../shared/service-status.js";

/** Shared bee-body path data (an oval-ish body with two stripe lines), reused by every drawn-bee icon. */
function BeeBody(): React.JSX.Element {
	return (
		<>
			<ellipse cx={12} cy={13} rx={4.4} ry={5.4} fill="none" stroke="currentColor" strokeWidth={1.6} />
			<path d="M8.4 11.2h7.2M8.1 14.4h7.8" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
			<circle cx={12} cy={6.6} r={2.1} fill="none" stroke="currentColor" strokeWidth={1.6} />
			<path d="M10.8 5.2 9.6 3.2M13.2 5.2l1.2-2" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
		</>
	);
}

const ICON_PROPS = {
	width: 22,
	height: 22,
	viewBox: "0 0 24 24",
	"aria-hidden": true,
	focusable: false,
} as const;

/** `starting` — an empty honeycomb cell outline; no bee has emerged yet. */
function StartingIcon(): React.JSX.Element {
	return (
		<svg {...ICON_PROPS} data-service-state="starting">
			<path
				d="M12 3.5 19 7.75v8.5L12 20.5 5 16.25v-8.5z"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.6}
				strokeDasharray="2.5 2.5"
				strokeLinejoin="round"
			/>
			<circle cx={12} cy={12} r={1.6} fill="currentColor" opacity={0.6} />
		</svg>
	);
}

/** `warming` — a bee with small, half-open wings (just checked in, not yet settled). */
function WarmingIcon(): React.JSX.Element {
	return (
		<svg {...ICON_PROPS} data-service-state="warming">
			<BeeBody />
			<path d="M8.2 12.4c-1.6-.6-2.6-.2-3-.7M15.8 12.4c1.6-.6 2.6-.2 3-.7" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" opacity={0.65} />
		</svg>
	);
}

/** `active` — a bee with full, wide-spread wings (settled, healthy, flying). */
function ActiveIcon(): React.JSX.Element {
	return (
		<svg {...ICON_PROPS} data-service-state="active">
			<BeeBody />
			<ellipse cx={5.6} cy={10.4} rx={2.6} ry={1.7} fill="none" stroke="currentColor" strokeWidth={1.3} transform="rotate(-24 5.6 10.4)" />
			<ellipse cx={18.4} cy={10.4} rx={2.6} ry={1.7} fill="none" stroke="currentColor" strokeWidth={1.3} transform="rotate(24 18.4 10.4)" />
		</svg>
	);
}

/** `degraded` — a bee with only ONE wing (asymmetric) plus a small caution mark. */
function DegradedIcon(): React.JSX.Element {
	return (
		<svg {...ICON_PROPS} data-service-state="degraded">
			<BeeBody />
			<ellipse cx={18.4} cy={10.4} rx={2.6} ry={1.7} fill="none" stroke="currentColor" strokeWidth={1.3} transform="rotate(24 18.4 10.4)" />
			<path d="M18.4 2.4v3.6M18.4 7.4v.01" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
		</svg>
	);
}

/** `error` — a bee on its back with wings crossed into an X (stopped, needs attention). */
function ErrorIcon(): React.JSX.Element {
	return (
		<svg {...ICON_PROPS} data-service-state="error">
			<g transform="rotate(180 12 12)">
				<BeeBody />
			</g>
			<path d="M8.6 9.6l3.4 3.4-3.4 3.4M15.4 9.6l-3.4 3.4 3.4 3.4" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" opacity={0.85} />
		</svg>
	);
}

/** The fail-safe fallback icon for any value outside the five locked states (svg-AC-5). */
function UnknownIcon(): React.JSX.Element {
	return (
		<svg {...ICON_PROPS} data-service-state="unknown">
			<circle cx={12} cy={12} r={8} fill="none" stroke="currentColor" strokeWidth={1.6} strokeDasharray="3 3" />
			<path d="M12 9v4M12 15.5v.01" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
		</svg>
	);
}

/**
 * The single shared state→icon mapping (svg-AC-4). Every consumer resolves a state's icon through
 * THIS function only — never a per-component switch — so `/buzzing` and the health rail render the
 * identical icon for the identical state.
 */
export function ServiceStateIcon({ state }: { readonly state: string }): React.JSX.Element {
	if (!isServiceState(state)) return <UnknownIcon />;
	const resolved: ServiceState = state;
	switch (resolved) {
		case "starting":
			return <StartingIcon />;
		case "warming":
			return <WarmingIcon />;
		case "active":
			return <ActiveIcon />;
		case "degraded":
			return <DegradedIcon />;
		case "error":
			return <ErrorIcon />;
		default: {
			const exhaustive: never = resolved;
			return exhaustive;
		}
	}
}

/** A short, human label per state (used for `title`/`aria-label` alongside the icon). */
export const SERVICE_STATE_LABEL: Record<ServiceState, string> = {
	starting: "starting",
	warming: "warming up",
	active: "active",
	degraded: "degraded",
	error: "error",
};

/** The color token reinforcing (never solely conveying, svg-AC-2) each state. */
export const SERVICE_STATE_COLOR: Record<ServiceState, string> = {
	starting: "var(--text-tertiary)",
	warming: "var(--severity-warning)",
	active: "var(--verified)",
	degraded: "var(--severity-warning)",
	error: "var(--severity-critical)",
};
