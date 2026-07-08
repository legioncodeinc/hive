/**
 * The harness-connect dashboard card, PRD-006d (d-AC-2/3/5).
 *
 * Renders one row per harness from the AUTHORITATIVE honeycomb-CLI-backed status read
 * (`wire.harnessConnectionStatus()` -> `GET /api/diagnostics/harness-connect-status`): agent
 * present? plugin enabled (connected)? last reconcile outcome? (d-AC-2). Each row carries a
 * Reconnect / Repair button that re-runs the connector setup (`wire.repairHarness()`) and updates
 * the shown state on success (d-AC-3). A repair that cannot complete shows a clear, plain-language
 * message and never blocks the dashboard (d-AC-5).
 *
 * The status read is polled SLOWLY ({@link HARNESS_CONNECT_POLL_MS}, 30s) because each read shells a
 * honeycomb process server-side, so it deliberately uses a far slower cadence than the 2-5s
 * dashboard reads (PRODUCT DEFAULT). Built entirely from the existing DS primitives (`Panel`,
 * `Badge`, `Button`); no new token or asset. The card SELF-HIDES when there is nothing to report.
 */

import React from "react";

import { Panel } from "./panels.js";
import { Badge, Button } from "./primitives.js";
import { useSwr } from "./use-swr.js";
import {
	ENDPOINTS,
	swrKey,
	type HarnessConnectionStateWire,
	type HarnessRepairResultWire,
	type WireClient,
} from "./wire.js";

/**
 * The status-poll cadence (ms). Deliberately slow: each read shells a honeycomb process, so this is
 * NOT the 2-5s dashboard cadence (PRODUCT DEFAULT, d-OQ).
 */
export const HARNESS_CONNECT_POLL_MS = 30_000;

/** The per-harness repair state: which harness is in flight, and the last result to render. */
interface RepairState {
	readonly harness: string;
	readonly result: HarnessRepairResultWire | null;
}

/** A plain-language, non-secret message for a completed repair (d-AC-3/5). */
function repairMessage(result: HarnessRepairResultWire | null): string {
	if (result === null) return "Could not reach honeycomb. Try again.";
	if (result.connected) return "Repaired: connected.";
	switch (result.status) {
		case "agent-absent":
			return "Agent not installed. Install it, then repair.";
		case "cli-absent":
			return "Honeycomb CLI not found. Nothing to wire yet.";
		case "connected":
			return "Repaired: connected.";
		case "error":
			return `Could not repair${result.detail !== undefined && result.detail !== "" ? ` (${result.detail})` : ""}.`;
		default: {
			// Exhaustiveness: a new status variant must be handled explicitly.
			const _never: never = result.status;
			return String(_never);
		}
	}
}

/** One harness row: agent-present + plugin-enabled badges, last outcome, and the Repair action. */
function HarnessRow({
	row,
	busy,
	repair,
	repairState,
}: {
	readonly row: HarnessConnectionStateWire;
	readonly busy: boolean;
	readonly repair: (harness: string) => void;
	readonly repairState: RepairState | null;
}): React.JSX.Element {
	const showRepairMsg = repairState !== null && repairState.harness === row.harness;
	return (
		<div
			data-testid={`harness-connect-row-${row.harness}`}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 10,
				padding: "10px 6px",
				borderTop: "1px solid var(--border-subtle)",
				flexWrap: "wrap",
			}}
		>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)", minWidth: 110 }}>
				{row.harness}
			</span>
			<Badge tone={row.agentPresent ? "verified" : "neutral"} mono dot>
				{row.agentPresent ? "agent present" : "agent absent"}
			</Badge>
			<Badge tone={row.pluginEnabled ? "verified" : "warning"} mono dot>
				{row.pluginEnabled ? "plugin enabled" : "not connected"}
			</Badge>
			{row.lastOutcome !== undefined && row.lastOutcome !== "" && (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>last: {row.lastOutcome}</span>
			)}
			<span style={{ flex: 1 }} />
			{showRepairMsg && (
				<span
					data-testid={`harness-connect-repair-msg-${row.harness}`}
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						color: repairState.result?.connected ? "var(--verified)" : "var(--text-secondary)",
					}}
				>
					{repairMessage(repairState.result)}
				</span>
			)}
			<Button
				variant="secondary"
				size="sm"
				disabled={busy}
				onClick={() => repair(row.harness)}
				data-testid={`harness-connect-repair-${row.harness}`}
			>
				{busy ? "…" : row.connected ? "Repair" : "Reconnect"}
			</Button>
		</div>
	);
}

export interface HarnessConnectCardProps {
	/** The shared dashboard wire client. */
	readonly wire: WireClient;
	/** Test seam: override the status-poll cadence (a test passes 0 to disable interval polling). */
	readonly pollMs?: number;
}

export function HarnessConnectCard({ wire, pollMs = HARNESS_CONNECT_POLL_MS }: HarnessConnectCardProps): React.JSX.Element | null {
	const { data: rows = [], mutate } = useSwr<HarnessConnectionStateWire[]>(
		swrKey(ENDPOINTS.harnessConnectStatus),
		async () => wire.harnessConnectionStatus(),
		{ refreshInterval: pollMs },
	);

	const [busyHarness, setBusyHarness] = React.useState<string | null>(null);
	const [repairState, setRepairState] = React.useState<RepairState | null>(null);

	// Mirror `dashboard.tsx`'s `recall()` busy/result handler: one in-flight repair at a time; on
	// completion, re-read the status so the shown state reflects what actually persisted (d-AC-3).
	const repair = React.useCallback(
		async (harness: string): Promise<void> => {
			if (busyHarness !== null) return;
			setBusyHarness(harness);
			setRepairState(null);
			const result = await wire.repairHarness(harness);
			setRepairState({ harness, result });
			setBusyHarness(null);
			// Re-read the authoritative status (never an optimistic flip). A null result (fail-soft)
			// still re-reads, so the row reflects the real state and the operator can retry (d-AC-5).
			mutate();
		},
		[busyHarness, wire, mutate],
	);

	// Self-hide when there is nothing to report (no configured harnesses, or a fail-soft empty read).
	if (rows.length === 0) return null;

	return (
		<div data-testid="harness-connect-card">
			<Panel title="Coding assistants" eyebrow={`${rows.length} connected checks`}>
				<div style={{ display: "flex", flexDirection: "column" }}>
					{rows.map((row) => (
						<HarnessRow
							key={row.harness}
							row={row}
							busy={busyHarness === row.harness}
							repair={(h) => void repair(h)}
							repairState={repairState}
						/>
					))}
				</div>
			</Panel>
		</div>
	);
}
