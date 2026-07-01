/**
 * Portal readiness splash — PRD-002b (rs-AC-1 through rs-AC-9) · PRD-003c (m-AC-7, now the
 * content the `/buzzing` route mounts, per `main.tsx`).
 *
 * Polls `GET /api/fleet-status` until `isFleetReady()` passes, then mounts {@link LoginScreen}
 * once. Before the gate passes, LoginScreen is not mounted at all, so its `/setup/state` poll
 * cannot fire on a cold boot and misread a not-yet-ready honeycomb as "First time setup."
 *
 * PRD-003a's server-side gate is now the AUTHORITATIVE decision-maker for which URL an operator
 * lands on (health, then auth, per `the-hive/src/daemon/gate.ts`) — `/buzzing` itself is
 * gate-exempt, so this component's own ready→{@link LoginScreen} transition only matters for an
 * operator who is SITTING on `/buzzing` while the fleet comes up (an interim convenience this PRD
 * inherits from PRD-002b unchanged; PRD-004 will flesh out `/buzzing`'s full content and may revisit
 * this transition).
 *
 * Visual polish pass (ux-ui-worker-bee, deferred by PRD-002b's non-goals): a calm bordered panel,
 * a honey-tinted halo behind the brand mark, a distinct recessed treatment for the "hivedoctor
 * unreachable" state, and a `role="status" aria-live="polite"` region so assistive tech announces
 * state changes while the fleet boots. All values are existing design tokens; no poll/gate logic
 * below is touched.
 */

import React from "react";

import {
	isFleetReady,
	type FleetHealth,
	type FleetStatusResponse,
} from "../../shared/fleet-readiness.js";
import { LoginScreen } from "./setup-gate.js";

export { isFleetReady as isReady } from "../../shared/fleet-readiness.js";
export type { FleetStatusResponse } from "../../shared/fleet-readiness.js";

/** Per-daemon row state shown on the readiness splash (rs-AC-5). */
export type DaemonDisplayState = "up" | "degraded" | "unreachable" | "starting";

/** Maps hivedoctor `daemons[].health` to splash copy/state (rs-AC-5). */
export function deriveDaemonDisplayState(health: FleetHealth): DaemonDisplayState {
	switch (health) {
		case "ok":
			return "up";
		case "degraded":
			return "degraded";
		case "unreachable":
			return "unreachable";
		case "unknown":
			return "starting";
		default: {
			const exhaustive: never = health;
			return exhaustive;
		}
	}
}

const DISPLAY_STATE_COLOR: Record<DaemonDisplayState, string> = {
	up: "var(--verified)",
	degraded: "var(--severity-warning)",
	unreachable: "var(--severity-critical)",
	starting: "var(--text-tertiary)",
};

export interface ReadinessSplashProps {
	readonly assetBase: string;
	readonly pollMs?: number;
}

function DaemonStatusDot({
	displayState,
	name,
}: {
	readonly displayState: DaemonDisplayState;
	readonly name: string;
}): React.JSX.Element {
	const pulsing = displayState === "starting";
	return (
		<span
			role="img"
			aria-label={`${name}: ${displayState}`}
			style={{
				width: 8,
				height: 8,
				borderRadius: "50%",
				flex: "none",
				background: DISPLAY_STATE_COLOR[displayState],
				animation: pulsing
					? "hc-readiness-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate"
					: "none",
			}}
		/>
	);
}

/**
 * The distinct "hivedoctor unreachable" indicator (rs-AC-6). A single muted, recessed block rather
 * than a per-daemon row, so an operator can tell "the supervisor itself is down" apart from "the
 * supervisor is up and the fleet is booting" at a glance. Reuses the `starting` display-state color
 * (muted, not alarming) since a not-yet-reachable supervisor on a cold boot is expected, not an
 * error state.
 */
function SupervisorUnreachableIndicator(): React.JSX.Element {
	return (
		<div
			data-testid="readiness-hivedoctor-unreachable"
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
				style={{
					width: 8,
					height: 8,
					borderRadius: "50%",
					flex: "none",
					background: DISPLAY_STATE_COLOR.starting,
					animation: "hc-readiness-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate",
				}}
			/>
			<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
				Waiting on hivedoctor. The fleet supervisor is not reachable yet.
			</p>
		</div>
	);
}

function FleetSplashGrid({
	status,
	assetBase,
}: {
	readonly status: FleetStatusResponse | null;
	readonly assetBase: string;
}): React.JSX.Element {
	const supervisorUnreachable = status?.supervisor === "unreachable";
	const daemons = status?.supervisor === "reachable" ? status.daemons : [];

	return (
		<div
			data-testid="readiness-splash"
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
			{/* The calm splash panel: a bordered surface (not the bare canvas) so the "waiting" state
			    reads as considered, not a flash of unstyled content. Sized off the type block's old
			    460px max-width, generously padded per the spacing scale. */}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 24,
					width: "100%",
					maxWidth: 420,
					padding: "40px 32px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-xl)",
				}}
			>
				{/* A honey halo behind the brand mark: the one saturated honey region this view earns,
				    per the token file's brand scarcity rule. */}
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

				<h1
					className="readiness-headline"
					style={{
						fontSize: "var(--text-xl)",
						fontWeight: 700,
						color: "var(--text-primary)",
						margin: 0,
						letterSpacing: "-0.02em",
					}}
				>
					Waiting for the hive&hellip;
				</h1>

				{/* rs-AC-5/rs-AC-6: the live status region. One `aria-live="polite"` announcer covers both
				    the top-level supervisor state and the per-daemon grid beneath it, so a screen-reader
				    user hears each transition once as the fleet boots, not a wall of duplicate regions. */}
				<div
					data-testid="readiness-status-region"
					role="status"
					aria-live="polite"
					style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, width: "100%" }}
				>
					{supervisorUnreachable ? (
						<SupervisorUnreachableIndicator />
					) : (
						<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
							Starting required daemons. This usually takes a few seconds on a cold boot.
						</p>
					)}

					{daemons.length > 0 && (
						<ul
							data-testid="readiness-daemon-grid"
							style={{
								listStyle: "none",
								margin: 0,
								padding: 0,
								display: "flex",
								flexDirection: "column",
								gap: 10,
								width: "100%",
								textAlign: "left",
							}}
						>
							{daemons.map((daemon) => {
								const displayState = deriveDaemonDisplayState(daemon.health);
								return (
									<li
										key={daemon.name}
										data-testid={`readiness-daemon-${daemon.name}`}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 10,
											padding: "10px 12px",
											borderRadius: "var(--radius-md)",
											border: "1px solid var(--border-subtle)",
											background: "var(--bg-elevated)",
										}}
									>
										<DaemonStatusDot displayState={displayState} name={daemon.name} />
										<span
											style={{
												flex: 1,
												fontSize: "var(--text-sm)",
												color: "var(--text-primary)",
												fontFamily: "var(--font-sans)",
											}}
										>
											{daemon.name}
										</span>
										<span
											style={{
												fontSize: "var(--text-xs)",
												color: "var(--text-secondary)",
												fontFamily: "var(--font-mono)",
												textTransform: "lowercase",
											}}
										>
											{displayState}
										</span>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</div>

			{/* Both keyframes reuse the SAME named motion bucket already established in this file
			    (`--dur-pollinate` / `--ease-in-out`, the "waiting/pending" bucket also used by
			    MemoryCard's pollinating pulse in primitives.tsx), so no bespoke duration/curve is
			    introduced. `prefers-reduced-motion` is handled globally in `assets/tokens/base.css`
			    (every animation collapses to a single frame), so no per-component media query is
			    needed here. */}
			<style>
				{"@keyframes hc-readiness-pulse { from { opacity: .45 } to { opacity: 1 } } " +
					"@keyframes hc-readiness-glow { from { opacity: .85 } to { opacity: 1 } } " +
					".readiness-headline { animation: hc-readiness-glow var(--dur-pollinate) var(--ease-in-out) infinite alternate; }"}
			</style>
		</div>
	);
}

/**
 * Top-level readiness gate (rs-AC-1). Polls `/api/fleet-status` and mounts {@link LoginScreen} only
 * once the fleet is ready. The gate is sticky (rs-AC-9): after LoginScreen mounts, a later not-ready
 * poll does not unmount it.
 */
export function ReadinessSplash({ assetBase, pollMs = 1500 }: ReadinessSplashProps): React.JSX.Element {
	const [status, setStatus] = React.useState<FleetStatusResponse | null>(null);
	const [fleetGated, setFleetGated] = React.useState(false);

	React.useEffect(() => {
		if (fleetGated) return;
		let alive = true;
		const tick = async (): Promise<void> => {
			try {
				const response = await fetch("/api/fleet-status");
				const next = (await response.json()) as FleetStatusResponse;
				if (!alive) return;
				setStatus(next);
				if (isFleetReady(next)) {
					setFleetGated(true);
				}
			} catch {
				// Keep the splash visible; the next poll retries.
			}
		};
		void tick();
		const id = setInterval(() => void tick(), pollMs);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [fleetGated, pollMs]);

	if (fleetGated) {
		return <LoginScreen assetBase={assetBase} />;
	}

	return <FleetSplashGrid status={status} assetBase={assetBase} />;
}
