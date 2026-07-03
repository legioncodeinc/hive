/**
 * The GREEN-LIGHT HEALTH step, PRD-009b ob-AC-13. Polls `GET /api/onboarding/health` until the
 * fleet reads ready, rendering one row per reported daemon using the SAME bee-state vocabulary
 * `/buzzing` renders (`service-icons.tsx` / `service-status.ts`), so a health-conscious operator
 * sees a consistent visual language across the whole onboarding-to-dashboard journey.
 */

import React from "react";

import type { FleetDaemonStatus } from "../../../shared/fleet-readiness.js";
import { deriveServiceState, fromFleetDaemonStatus } from "../../../shared/service-status.js";
import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "../service-icons.js";
import type { OnboardingClient } from "./onboarding-client.js";

export interface HealthViewProps {
	readonly client: OnboardingClient;
	/** Called once `ready:true` is observed. */
	readonly onReady: () => void;
	/** Overrides the poll interval (ms). Defaults to 1500, mirroring `/buzzing`'s dismissal poll. */
	readonly pollMs?: number;
}

/** ob-AC-13, the fleet reads ready only once; this screen stops polling the instant it does. */
export function HealthView({ client, onReady, pollMs = 1500 }: HealthViewProps): React.JSX.Element {
	const [daemons, setDaemons] = React.useState<readonly FleetDaemonStatus[]>([]);
	const [ready, setReady] = React.useState(false);

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
					maxWidth: 480,
					padding: "40px 36px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-xl)",
				}}
			>
				<h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Bringing the fleet up green
				</h1>
				<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					One last check before your dashboard: every daemon needs to report healthy.
				</p>

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
									<span style={{ color: SERVICE_STATE_COLOR[state], display: "inline-flex", flex: "none" }}>
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
			</div>
		</div>
	);
}
