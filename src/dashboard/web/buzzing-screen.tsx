/**
 * The `/buzzing` READINESS screen — hive PRD-004a. The addressable successor to PRD-002's
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
 *
 * UX rework (operator report): the screen used to look stalled during a long wait, with no motion
 * once a tile settled into one state, no sense of how long "a few seconds" really means, and
 * nothing to read while waiting. This adds an always-running progress affordance, an honest time
 * expectation (never a fake countdown) plus a calm "still working" note past a reasonable window,
 * a legible summary of which service is the long pole, and a short "while you wait"/"what's next"
 * pair so the wait teaches something instead of just sitting there. None of this changes what
 * "ready" means: `isFleetReady()` and the dismissal poll below are untouched.
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

/** Past this many ms without readiness, the "still working" note appears (a calm, not-alarming note, never a claim of failure). */
const EXTENDED_WAIT_MS = 45_000;

/** One service tile (bz-AC-3): the shared bee-state icon, the service name, and its state label. */
function ServiceTile({ service }: { readonly service: ServiceView }): React.JSX.Element {
	// A lingering non-active state (starting/warming/degraded) still breathes, so a tile that sits
	// unchanged for a while never reads as stalled; `error` and `active` are both terminal-for-now
	// and stay still on purpose.
	const stillWorking = service.state === "starting" || service.state === "warming" || service.state === "degraded";
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
			<span
				style={{
					color: SERVICE_STATE_COLOR[service.state],
					display: "inline-flex",
					flex: "none",
					animation: stillWorking ? "hc-readiness-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" : "none",
				}}
			>
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

/** The distinct "no service enumerated yet" indicator (mirrors the old doctor-unreachable state). */
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
				aria-label="doctor supervisor: unreachable"
				style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--text-tertiary)", animation: "hc-readiness-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" }}
			/>
			<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5, textAlign: "center" }}>
				Waiting on doctor. No services are registered yet.
			</p>
		</div>
	);
}

/** An always-running indeterminate progress affordance: motion the operator can see regardless of tile state. */
function IndeterminateProgressBar(): React.JSX.Element {
	return (
		<div
			data-testid="buzzing-progress-bar"
			role="progressbar"
			aria-label="Fleet still starting"
			style={{
				width: "100%",
				height: 6,
				borderRadius: "var(--radius-full)",
				background: "var(--bg-inset)",
				border: "1px solid var(--border-subtle)",
				overflow: "hidden",
				position: "relative",
			}}
		>
			<div
				style={{
					position: "absolute",
					inset: 0,
					width: "40%",
					borderRadius: "var(--radius-full)",
					background: "linear-gradient(90deg, transparent, var(--honey), transparent)",
					animation: "hc-shimmer-sweep 1.6s var(--ease-in-out) infinite",
				}}
			/>
		</div>
	);
}

/** One row of the compact "while you wait" product primer (bee-fleet copy, one line each, honest and short). */
interface WhileYouWaitEntry {
	readonly name: string;
	readonly blurb: string;
	readonly icon: string;
}

function whileYouWaitEntries(assetBase: string): readonly WhileYouWaitEntry[] {
	return [
		{ name: "Hive", blurb: "Your one dashboard: the front door to the whole fleet.", icon: "/assets/brand/hive-mark.svg" },
		{ name: "Honeycomb", blurb: "Shared AI memory your coding tools carry across sessions.", icon: `${assetBase}/honeycomb-memory-cluster.svg` },
		{ name: "Nectar", blurb: "Gives every file a stable identity, so recall survives renames.", icon: "/assets/brand/nectar-mark.svg" },
		{ name: "Doctor", blurb: "The watchdog that restarts crashed daemons and keeps the fleet healthy.", icon: "/assets/brand/doctor-mark.svg" },
	];
}

/** The compact, skimmable "while you wait" primer (one line per product, never a wall of text). */
function WhileYouWait({ assetBase }: { readonly assetBase: string }): React.JSX.Element {
	return (
		<div data-testid="buzzing-while-you-wait" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", textAlign: "left" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>
				While you wait
			</span>
			<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
				{whileYouWaitEntries(assetBase).map((entry) => (
					<li key={entry.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<img src={entry.icon} width={18} height={18} alt="" aria-hidden="true" style={{ flex: "none" }} />
						<span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: 1.4 }}>
							<strong style={{ color: "var(--text-primary)" }}>{entry.name}:</strong> {entry.blurb}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** A legible one-line summary of which services are still not settled (never claims failure). */
function longPoleSummary(services: readonly ServiceView[]): string | null {
	const notReady = services.filter((service) => service.state !== "active");
	if (notReady.length === 0) return null;
	const parts = notReady.map((service) => `${service.name} (${SERVICE_STATE_LABEL[service.state]})`);
	return notReady.length === 1 ? `Still settling: ${parts[0]}.` : `Still settling: ${parts.join(", ")}.`;
}

/**
 * The `/buzzing` readiness screen. Uses the shared telemetry hook for the tile grid and its own,
 * independent `isFleetReady()` poll for dismissal (see module doc for why the two are separate).
 */
export function BuzzingScreen({ assetBase, pollMs = 1500, onReady }: BuzzingScreenProps): React.JSX.Element {
	const telemetry = useFleetTelemetry();
	const [ready, setReady] = React.useState(false);
	const [elapsedMs, setElapsedMs] = React.useState(0);

	// A plain wall-clock tick, independent of any poll: the "still working" note and the honest
	// time-expectation copy read real elapsed time, never a fabricated countdown.
	React.useEffect(() => {
		if (ready) return;
		const startedAt = Date.now();
		const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
		return () => clearInterval(id);
	}, [ready]);

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

	const longPole = longPoleSummary(telemetry.services);

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
					maxWidth: 560,
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
						animation: "hc-badge-breathe 2.4s var(--ease-in-out) infinite alternate",
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
						Starting required services.
					</p>
					<p data-testid="buzzing-time-expectation" style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, lineHeight: 1.5 }}>
						This usually takes about 20 to 40 seconds on a fresh install; a cold boot can take a minute.
					</p>
					{elapsedMs > EXTENDED_WAIT_MS && (
						<p
							data-testid="buzzing-still-working"
							role="note"
							style={{ fontSize: "var(--text-xs)", color: "var(--severity-info)", margin: 0, lineHeight: 1.5 }}
						>
							Still working. Some services take longer on first run; this is not stuck.
						</p>
					)}

					<IndeterminateProgressBar />

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

					{longPole !== null && (
						<p data-testid="buzzing-long-pole" style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, lineHeight: 1.5 }}>
							{longPole}
						</p>
					)}
				</div>

				<WhileYouWait assetBase={assetBase} />

				<p data-testid="buzzing-whats-next" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Once every service reports ready, you will land straight on your dashboard, already linked to
					Deeplake. From there, the Apiary keeps your whole local AI fleet visible and healthy, day to day.
				</p>
			</div>

			<style>
				{[
					"@keyframes hc-readiness-pulse { from { opacity: .45 } to { opacity: 1 } }",
					"@keyframes hc-badge-breathe { from { transform: scale(1); opacity: 0.9 } to { transform: scale(1.05); opacity: 1 } }",
					"@keyframes hc-shimmer-sweep { 0% { transform: translateX(-120%) } 100% { transform: translateX(340%) } }",
				].join("\n")}
			</style>
		</div>
	);
}
