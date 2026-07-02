/**
 * The top HEALTH RAIL — hive PRD-005a. A strip of per-service status pills, mounted once in
 * the {@link Shell} (`app.tsx`) so it is present on EVERY in-app route (hr-AC-1), giving an
 * operator constant fleet awareness without leaving their current page.
 *
 * Fed by the SAME shared {@link useFleetTelemetry} hook `/buzzing` uses (SSE-first, `/api/fleet-status`
 * fail-soft — hr-AC-3/hr-AC-4/hr-AC-5) and the SAME shared {@link ServiceStateIcon} vocabulary
 * (PRD-004b) as `/buzzing`'s tiles, so a state means the same icon on both surfaces (hr-AC-2).
 *
 * Memory (hr-AC-7): the rail renders only the hook's CURRENT `services` snapshot on every render —
 * it holds no history of its own, so nothing here grows with connection time.
 */

import React from "react";

import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "./service-icons.js";
import { useFleetTelemetry, type ServiceView } from "./use-fleet-telemetry.js";

/** The `/health` page's route (PRD-005b), so the rail can link an operator straight to detail. */
export const HEALTH_ROUTE = "/health" as const;

/**
 * Standard visually-hidden style: real text content for assistive tech (the rail is an aria-live
 * region, so the STATE must live in the accessible text, not only in `title`/the aria-hidden icon),
 * invisible to sighted operators who already get the icon + color.
 */
const VISUALLY_HIDDEN_STYLE: React.CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	padding: 0,
	margin: -1,
	overflow: "hidden",
	clip: "rect(0, 0, 0, 0)",
	whiteSpace: "nowrap",
	border: 0,
};

/** One rail pill: the shared state icon + the service name, colored by state (never color-only, svg-AC-2). */
function ServicePill({ service }: { readonly service: ServiceView }): React.JSX.Element {
	const label = `${service.name}: ${SERVICE_STATE_LABEL[service.state]}`;
	return (
		<span
			data-testid={`health-rail-pill-${service.name}`}
			data-state={service.state}
			title={label}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				height: 26,
				padding: "0 10px",
				borderRadius: "var(--radius-full)",
				border: "1px solid var(--border-default)",
				background: "var(--bg-elevated)",
				flex: "none",
			}}
		>
			<span style={{ color: SERVICE_STATE_COLOR[service.state], display: "inline-flex", width: 14, height: 14 }} aria-hidden="true">
				<ServiceStateIcon state={service.state} />
			</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
				{service.name}
				<span style={VISUALLY_HIDDEN_STYLE}>: {SERVICE_STATE_LABEL[service.state]}</span>
			</span>
		</span>
	);
}

/** Props for {@link HealthRail}. */
export interface HealthRailProps {
	/** Navigate to the full `/health` page (the shell's path router). */
	readonly onOpenHealth?: () => void;
}

/**
 * The health rail (hr-AC-1/hr-AC-2). Renders one pill per KNOWN service (from the registered-name
 * enumeration + whatever telemetry has reported), a `role="status"` region so a screen reader
 * announces changes, and — when a handler is supplied — a link to the full `/health` page.
 */
export function HealthRail({ onOpenHealth }: HealthRailProps = {}): React.JSX.Element {
	const telemetry = useFleetTelemetry();

	return (
		<div
			data-testid="health-rail"
			role="status"
			aria-live="polite"
			aria-label="Fleet health"
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "8px 28px",
				borderBottom: "1px solid var(--border-subtle)",
				overflowX: "auto",
			}}
		>
			{telemetry.services.length === 0 ? (
				<span data-testid="health-rail-empty" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
					no services registered
				</span>
			) : (
				telemetry.services.map((service) => <ServicePill key={service.name} service={service} />)
			)}
			<span style={{ flex: 1 }} />
			{onOpenHealth !== undefined && (
				<button
					type="button"
					data-testid="health-rail-open-health"
					onClick={onOpenHealth}
					style={{
						background: "transparent",
						border: "none",
						color: "var(--text-tertiary)",
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						cursor: "pointer",
						padding: 0,
					}}
				>
					health details →
				</button>
			)}
		</div>
	);
}
