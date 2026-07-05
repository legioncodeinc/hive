/**
 * The GREEN-LIGHT HEALTH step, PRD-009b ob-AC-13. Polls `GET /api/onboarding/health` until the
 * fleet reads ready, rendering one row per reported daemon using the SAME bee-state vocabulary
 * `/buzzing` renders (`service-icons.tsx` / `service-status.ts`), so a health-conscious operator
 * sees a consistent visual language across the whole onboarding-to-dashboard journey.
 *
 * UX rework (operator report): mirrors `/buzzing`'s rework (`buzzing-screen.tsx`) so the two
 * "please wait" screens in this journey read as the same product: an always-running progress
 * affordance, an honest (never faked) time expectation plus a calm "still working" note past a
 * reasonable window, a legible summary of which daemon is the long pole, and a short "while you
 * wait"/"what's next" pair so the wait teaches something. The polling and `onReady` advance below
 * are untouched: none of this changes what "ready" means.
 */

import React from "react";

import type { FleetDaemonStatus } from "../../../shared/fleet-readiness.js";
import { deriveServiceState, fromFleetDaemonStatus, type ServiceState } from "../../../shared/service-status.js";
import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "../service-icons.js";
import type { OnboardingClient } from "./onboarding-client.js";

export interface HealthViewProps {
	readonly client: OnboardingClient;
	/** Called once `ready:true` is observed. */
	readonly onReady: () => void;
	/** Overrides the poll interval (ms). Defaults to 1500, mirroring `/buzzing`'s dismissal poll. */
	readonly pollMs?: number;
	/** The host-served asset base (mirrors every sibling onboarding step). Defaults to the same empty base the production host serves at. */
	readonly assetBase?: string;
}

/** Past this many ms without readiness, the "still working" note appears (calm, never a claim of failure). */
const EXTENDED_WAIT_MS = 45_000;

/** One row of the compact "while you wait" product primer, tuned for the pre-dashboard onboarding journey. */
interface WhileYouWaitEntry {
	readonly name: string;
	readonly blurb: string;
	readonly icon: string;
}

function whileYouWaitEntries(assetBase: string): readonly WhileYouWaitEntry[] {
	return [
		{ name: "Hive", blurb: "Your one dashboard: the front door to the whole fleet.", icon: "/assets/brand/hive-mark.svg" },
		{ name: "Honeycomb", blurb: "Shared AI memory your coding tools carry across sessions.", icon: "/assets/brand/honeycomb-mark.svg" },
		{ name: "Nectar", blurb: "Gives every file a stable identity, so recall survives renames.", icon: "/assets/brand/nectar-mark.svg" },
		{ name: "Doctor", blurb: "The watchdog that restarts crashed daemons and keeps the fleet healthy.", icon: "/assets/brand/doctor-mark.svg" },
	];
}

/** The compact, skimmable "while you wait" primer (one line per product, never a wall of text). */
function WhileYouWait({ assetBase }: { readonly assetBase: string }): React.JSX.Element {
	return (
		<div data-testid="onboarding-health-while-you-wait" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", textAlign: "left" }}>
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

/** A legible one-line summary of which daemons are still not settled (never claims failure). */
function longPoleSummary(rows: ReadonlyArray<{ readonly name: string; readonly state: ServiceState }>): string | null {
	const notReady = rows.filter((row) => row.state !== "active");
	if (notReady.length === 0) return null;
	const parts = notReady.map((row) => `${row.name} (${SERVICE_STATE_LABEL[row.state]})`);
	return notReady.length === 1 ? `Still settling: ${parts[0]}.` : `Still settling: ${parts.join(", ")}.`;
}

/** An always-running indeterminate progress affordance: motion the operator can see regardless of row state. */
function IndeterminateProgressBar(): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-health-progress-bar"
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

/** ob-AC-13, the fleet reads ready only once; this screen stops polling the instant it does. */
export function HealthView({ client, onReady, pollMs = 1500, assetBase = "" }: HealthViewProps): React.JSX.Element {
	const [daemons, setDaemons] = React.useState<readonly FleetDaemonStatus[]>([]);
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

	React.useEffect(() => {
		if (ready) return;
		let alive = true;
		let inFlight = false;
		const tick = async (): Promise<void> => {
			if (inFlight) return;
			inFlight = true;
			try {
				const result = await client.health();
				if (!alive) return;
				setDaemons(result.status.supervisor === "reachable" ? result.status.daemons : []);
				if (result.ready) setReady(true);
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
	}, [ready, pollMs, client]);

	React.useEffect(() => {
		if (ready) onReady();
	}, [ready, onReady]);

	const rows = daemons.map((daemon) => ({
		name: daemon.name,
		state: deriveServiceState({ signal: fromFleetDaemonStatus(daemon), now: Date.now(), firstActiveAt: null }),
	}));
	const longPole = longPoleSummary(rows);

	return (
		<div
			data-testid="onboarding-health-view"
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
					gap: 22,
					width: "100%",
					maxWidth: 560,
					padding: "40px 36px",
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
						width: 72,
						height: 72,
						borderRadius: "50%",
						background: "var(--honey-subtle)",
						border: "1px solid var(--honey-border)",
						animation: "hc-badge-breathe 2.4s var(--ease-in-out) infinite alternate",
					}}
				>
					<img src="/assets/brand/hive-mark.svg" width={40} height={40} alt="" />
				</span>

				<h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Bringing the fleet up green
				</h1>
				<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					One last check before your dashboard: every daemon needs to report healthy.
				</p>
				<p data-testid="onboarding-health-time-expectation" style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, lineHeight: 1.5 }}>
					This usually takes about 20 to 40 seconds on a fresh install; a cold boot can take a minute.
				</p>
				{elapsedMs > EXTENDED_WAIT_MS && (
					<p
						data-testid="onboarding-health-still-working"
						role="note"
						style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", color: "var(--severity-info)", margin: 0, lineHeight: 1.5 }}
					>
						Still working. Some services take longer on first run; this is not stuck.
					</p>
				)}

				<IndeterminateProgressBar />

				<ul
					role="status"
					aria-live="polite"
					style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, width: "100%", textAlign: "left" }}
				>
					{daemons.length === 0 ? (
						<li style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Checking the fleet…</li>
					) : (
						daemons.map((daemon) => {
							const state = deriveServiceState({ signal: fromFleetDaemonStatus(daemon), now: Date.now(), firstActiveAt: null });
							const stillWorking = state === "starting" || state === "warming" || state === "degraded";
							return (
								<li
									key={daemon.name}
									data-testid={`onboarding-health-row-${daemon.name}`}
									data-state={state}
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
											color: SERVICE_STATE_COLOR[state],
											display: "inline-flex",
											flex: "none",
											animation: stillWorking ? "hc-readiness-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" : "none",
										}}
									>
										<ServiceStateIcon state={state} />
									</span>
									<span style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
										{daemon.name}
									</span>
									<span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
										{SERVICE_STATE_LABEL[state]}
									</span>
								</li>
							);
						})
					)}
				</ul>

				{longPole !== null && (
					<p data-testid="onboarding-health-long-pole" style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, lineHeight: 1.5 }}>
						{longPole}
					</p>
				)}

				<WhileYouWait assetBase={assetBase} />

				<p data-testid="onboarding-health-whats-next" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Next: a quick sign-in links this machine to your Deeplake account, then you pick a workspace and
					land on your dashboard. From there, the Apiary keeps your whole local AI fleet visible and
					healthy, day to day.
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
