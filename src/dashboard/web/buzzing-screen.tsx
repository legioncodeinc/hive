/**
 * The `/buzzing` READINESS screen — the-hive PRD-004a. The addressable successor to PRD-002's
 * `ReadinessSplash` (retired by this PRD, per PRD-004's "Overlap and supersession": "the
 * `ReadinessSplash` becomes `/buzzing`"), now rendering the real per-service tile grid ADR-0004
 * calls for instead of a coarse per-daemon list.
 *
 * Two independent concerns, kept deliberately separate:
 *   - DISMISSAL (bz-AC-9/bz-AC-10): polls `GET /api/fleet-status` and reuses the EXISTING, pinned
 *     `isFleetReady()` predicate (PRD-002a) — the identical rule the server gate (`gate.ts`)
 *     applies — so "ready" means one thing everywhere. Once ready, this screen hard-navigates to
 *     `/` so the SERVER gate re-evaluates health+auth on the fresh request and lands the operator
 *     on the dashboard or `/login`, whichever the (now-current) auth state calls for.
 *   - TILE RENDERING (bz-AC-1..8): the shared {@link useFleetTelemetry} hook (SSE-first,
 *     `/api/fleet-status` fail-soft), rendered one tile per registered service via the shared
 *     {@link ServiceStateIcon} vocabulary (PRD-004b). A single bad service only ever changes ITS
 *     tile (sd-AC-8/sd-AC-9) — the tile list itself is keyed by name and independent per row.
 */

import React from "react";

import { isFleetReady, type FleetStatusResponse } from "../../shared/fleet-readiness.js";
import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "./service-icons.js";
import { useFleetTelemetry, type ServiceView } from "./use-fleet-telemetry.js";

export interface BuzzingScreenProps {
	readonly assetBase: string;
	/** Override the `/api/fleet-status` dismissal-poll interval (ms). Defaults to 1500. */
	readonly pollMs?: number;
	/** Test seam: called instead of the real navigation once the fleet is ready. */
	readonly onReady?: () => void;
}

/** One service tile (bz-AC-3): the shared bee-state icon, the service name, and its state label. */
function ServiceTile({ service }: { readonly service: ServiceView }): React.JSX.Element {
	return (
		<li
			data-testid={`buzzing-tile-${service.name}`}
			data-state={service.state}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "10px 14px",
				borderRadius: "var(--radius-md)",
				border: "1px solid var(--border-subtle)",
				background: "var(--bg-elevated)",
			}}
		>
			<span style={{ color: SERVICE_STATE_COLOR[service.state], display: "inline-flex", flex: "none" }}>
				<ServiceStateIcon state={service.state} />
			</span>
			<span style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>{service.name}</span>
			<span
				data-testid={`buzzing-tile-state-${service.name}`}
				style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-secondary)", textTransform: "lowercase" }}
			>
				{SERVICE_STATE_LABEL[service.state]}
			</span>
		</li>
	);
}

/** The distinct "no service enumerated yet" indicator (mirrors the old hivedoctor-unreachable state). */
function AwaitingRegistrationIndicator(): React.JSX.Element {
	return (
		<div
			data-testid="buzzing-empty"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 12,
				width: "100%",
				padding: "16px 20px",
				background: "var(--bg-inset)",
				border: "1px solid var(--border-subtle)",
				borderRadius: "var(--radius-lg)",
			}}
		>
			<span
				role="img"
				aria-label="hivedoctor supervisor: unreachable"
				style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text-tertiary)", animation: "hc-readiness-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" }}
			/>
			<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5, textAlign: "center" }}>
				Waiting on hivedoctor. No services are registered yet.
			</p>
		</div>
	);
}

/**
 * The `/buzzing` readiness screen. Uses the shared telemetry hook for the tile grid and its own,
 * independent `isFleetReady()` poll for dismissal (see module doc for why the two are separate).
 */
export function BuzzingScreen({ assetBase, pollMs = 1500, onReady }: BuzzingScreenProps): React.JSX.Element {
	const telemetry = useFleetTelemetry();
	const [ready, setReady] = React.useState(false);

	// bz-AC-9/bz-AC-10: reuse the pinned `isFleetReady()` rule so dismissal means the same thing
	// here as it does in the server gate. Stops polling once ready (sticky, mirrors the retired
	// ReadinessSplash's rs-AC-7/rs-AC-9 discipline).
	React.useEffect(() => {
		if (ready) return;
		let alive = true;
		// One readiness request at a time: a slow/hung daemon must never stack overlapping polls
		// (this screen already shares the endpoint with useFleetTelemetry's own fallback poll).
		let inFlight = false;
		const tick = async (): Promise<void> => {
			if (inFlight) return;
			inFlight = true;
			try {
				const response = await fetch("/api/fleet-status");
				const next = (await response.json()) as FleetStatusResponse;
				if (!alive) return;
				if (isFleetReady(next)) setReady(true);
			} catch {
				// Keep the screen visible; the next poll retries.
			} finally {
				inFlight = false;
			}
		};
		void tick();
		const id = setInterval(() => void tick(), pollMs);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [ready, pollMs]);

	// On ready: navigate away. A HARD navigation (not a client-side route swap) so the SERVER gate
	// re-runs health+auth on the fresh request (PRD-003a) and lands the operator correctly.
	React.useEffect(() => {
		if (!ready) return;
		if (onReady !== undefined) {
			onReady();
			return;
		}
		if (typeof window !== "undefined") window.location.assign("/");
	}, [ready, onReady]);

	return (
		<div
			data-testid="buzzing-screen"
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				minHeight: "100vh",
				padding: 32,
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 24,
					width: "100%",
					maxWidth: 460,
					padding: "40px 32px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-xl)",
				}}
			>
				<span
					aria-hidden="true"
					style={{
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						flex: "none",
						width: 88,
						height: 88,
						borderRadius: "50%",
						background: "var(--honey-subtle)",
						border: "1px solid var(--honey-border)",
					}}
				>
					<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={48} height={48} alt="" />
				</span>

				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Waiting for the hive&hellip;
				</h1>

				<div
					data-testid="buzzing-status-region"
					role="status"
					aria-live="polite"
					style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, width: "100%" }}
				>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
						Starting required services. This usually takes a few seconds on a cold boot.
					</p>

					{telemetry.services.length === 0 ? (
						<AwaitingRegistrationIndicator />
					) : (
						// bz-AC-1/bz-AC-2/bz-AC-8: one tile per registered service, no omissions, all
						// visible simultaneously so the operator sees exactly what is blocking readiness.
						<ul
							data-testid="buzzing-tile-grid"
							style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, width: "100%", textAlign: "left" }}
						>
							{telemetry.services.map((service) => (
								<ServiceTile key={service.name} service={service} />
							))}
						</ul>
					)}
				</div>
			</div>

			<style>
				{"@keyframes hc-readiness-pulse { from { opacity: .45 } to { opacity: 1 } }"}
			</style>
		</div>
	);
}
