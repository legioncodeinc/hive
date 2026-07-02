/**
 * The `/health` PAGE — the-hive PRD-005b (per-service metrics + Deep Lake stats) and PRD-005c
 * (live log tail with selectable verbosity). Registered at `/health` in `registry.tsx`; reachable
 * via the health rail's "health details" link (PRD-005a) or direct navigation.
 *
 * `/health` shares the SAME literal path as thehive's own machine-liveness probe (`GET /health`
 * JSON, `server.ts`) — content negotiation on the SERVER (`accept: text/html` → this SPA page,
 * anything else → the liveness JSON) keeps both working at the identical URL (see `gate.ts` /
 * `server.ts` module docs). Client-side navigation (the sidebar link, `navigate()`) never touches
 * the network at all, so this collision only ever matters for a full page load/refresh, which the
 * server-side negotiation resolves.
 *
 * Fed entirely by the SHARED `useFleetTelemetry` hook (SSE-first, REST fail-soft) — no second
 * fetch/poll loop is introduced here (hm-AC-8, lg-AC-1).
 */

import React from "react";

import { Panel } from "../panels.js";
import { PageFrame } from "../page-frame.js";
import type { PageProps } from "../page-frame.js";
import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "../service-icons.js";
import {
	filterLogsByVerbosity,
	LOG_LEVELS,
	useFleetTelemetry,
	type FleetTelemetryView,
	type LogLevel,
	type ServiceView,
} from "../use-fleet-telemetry.js";
import type { FleetLogEntry } from "../../../shared/fleet-telemetry.js";

/** How many of the (already-bounded) filtered log lines the tail renders, newest first (a display cap, not a second buffer). */
const VISIBLE_LOG_LINES = 200;

// ─────────────────────────────────────────────────────────────────────────────
// hm-AC-1..3: per-service metrics, rendered GENERICALLY (never one service's key names hardcoded).
// ─────────────────────────────────────────────────────────────────────────────

/** Turn a camelCase metric key into a readable label (`filesProcessed` → `files processed`). */
function humanizeMetricKey(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** One service's metrics + Deep Lake block (hm-AC-1..3, hm-AC-5..7). Renders whatever keys are present. */
function ServiceHealthCard({ service }: { readonly service: ServiceView }): React.JSX.Element {
	const metricEntries = Object.entries(service.metrics);
	return (
		<div
			data-testid={`health-service-${service.name}`}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 10,
				padding: "14px 16px",
				borderRadius: "var(--radius-lg)",
				border: "1px solid var(--border-default)",
				background: "var(--bg-elevated)",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<span style={{ color: SERVICE_STATE_COLOR[service.state], display: "inline-flex", flex: "none" }}>
					<ServiceStateIcon state={service.state} />
				</span>
				<span style={{ fontWeight: 600, fontSize: "var(--text-base)", color: "var(--text-primary)" }}>{service.name}</span>
				<span
					data-testid={`health-service-state-${service.name}`}
					style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "lowercase" }}
				>
					{SERVICE_STATE_LABEL[service.state]}
				</span>
			</div>

			{/* hm-AC-1..3: since-last-restart counters, generic over whatever keys this service reports. */}
			{metricEntries.length === 0 ? (
				<div data-testid={`health-metrics-empty-${service.name}`} style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
					No metrics reported yet.
				</div>
			) : (
				<div data-testid={`health-metrics-${service.name}`} style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 4, columnGap: 12 }}>
					{metricEntries.map(([key, value]) => (
						<React.Fragment key={key}>
							<span style={{ fontSize: 12, color: "var(--text-secondary)", textTransform: "capitalize" }}>{humanizeMetricKey(key)}</span>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>{value}</span>
						</React.Fragment>
					))}
				</div>
			)}

			{/* hm-AC-5..7: Deep Lake connection state + last-communication time, when this service reports one. */}
			<div
				data-testid={`health-deeplake-${service.name}`}
				style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}
			>
				<span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Deep Lake</span>
				{service.deeplake === null ? (
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>not reported</span>
				) : (
					<>
						<span
							data-testid={`health-deeplake-state-${service.name}`}
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: service.deeplake.connected === true ? "var(--verified)" : "var(--severity-critical)",
							}}
						>
							{service.deeplake.connected === true ? "connected" : service.deeplake.connected === false ? "unreachable" : "unknown"}
						</span>
						<span style={{ flex: 1 }} />
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
							last comm: {service.deeplake.lastCommunicationAt ?? "never"}
						</span>
					</>
				)}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-005c: the live log tail + verbosity selector, over the SAME bounded buffer.
// ─────────────────────────────────────────────────────────────────────────────

/** One rendered log line (newest first). */
function LogLine({ entry }: { readonly entry: FleetLogEntry }): React.JSX.Element {
	return (
		<div style={{ display: "grid", gridTemplateColumns: "auto auto 1fr", gap: 10, padding: "4px 0", fontFamily: "var(--font-mono)", fontSize: 12 }}>
			<span style={{ color: "var(--text-tertiary)" }}>{(entry.ts || "").slice(11, 19) || entry.ts}</span>
			<span style={{ color: "var(--text-secondary)", textTransform: "uppercase" }}>{entry.level}</span>
			<span style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
				<span style={{ color: "var(--text-tertiary)" }}>[{entry.service}]</span> {entry.message}
			</span>
		</div>
	);
}

/** The verbosity selector (lg-AC-4): a native `<select>` matching the DS token style. */
function VerbositySelect({ value, onChange }: { readonly value: LogLevel; readonly onChange: (level: LogLevel) => void }): React.JSX.Element {
	return (
		<select
			aria-label="log verbosity"
			data-testid="log-verbosity-select"
			value={value}
			onChange={(e) => onChange(e.target.value as LogLevel)}
			style={{
				height: 30,
				padding: "0 8px",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
				color: "var(--text-primary)",
				fontFamily: "var(--font-mono)",
				fontSize: 12,
			}}
		>
			{LOG_LEVELS.map((level) => (
				<option key={level} value={level}>
					{level}+
				</option>
			))}
		</select>
	);
}

/** The live log tail panel (lg-AC-1..8): filtered by the selected verbosity, newest lines first, bounded display. */
function LiveLogTail({ logs }: { readonly logs: readonly FleetLogEntry[] }): React.JSX.Element {
	const [level, setLevel] = React.useState<LogLevel>("info");
	const filtered = filterLogsByVerbosity(logs, level);
	// Newest-first display over the already-bounded (ring-buffer) `logs` — never a second fetch.
	const visible = filtered.slice(Math.max(0, filtered.length - VISIBLE_LOG_LINES)).reverse();

	return (
		<Panel title="Live logs" eyebrow={`${filtered.length} of ${logs.length} lines`} right={<VerbositySelect value={level} onChange={setLevel} />}>
			{visible.length === 0 ? (
				<div data-testid="health-logs-empty" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
					No log lines at this verbosity yet.
				</div>
			) : (
				<div data-testid="health-logs-list" style={{ maxHeight: 360, overflowY: "auto" }}>
					{visible.map((entry, i) => (
						<LogLine key={`${entry.ts}-${entry.service}-${i}`} entry={entry} />
					))}
				</div>
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed page.
// ─────────────────────────────────────────────────────────────────────────────

/** True when there is nothing at all to show (hm-AC-10): no service is known from any source yet. */
function isTelemetryUnavailable(view: FleetTelemetryView): boolean {
	return view.services.length === 0;
}

/**
 * The `/health` page (PRD-005b + PRD-005c). Renders per-service metrics + Deep Lake stats
 * generically, plus a live, verbosity-filtered log tail — all from the ONE shared telemetry hook.
 */
export function HealthPage(_props: PageProps): React.JSX.Element {
	const telemetry = useFleetTelemetry();

	return (
		<PageFrame title="Health" eyebrow={telemetry.source === "sse" ? "live" : telemetry.source === "rest" ? "fallback" : "unavailable"}>
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				{isTelemetryUnavailable(telemetry) ? (
					<Panel title="Fleet metrics">
						<div data-testid="health-telemetry-unavailable" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
							Telemetry unavailable. Waiting for hivedoctor to report the fleet.
						</div>
					</Panel>
				) : (
					<div data-testid="health-service-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
						{telemetry.services.map((service) => (
							<ServiceHealthCard key={service.name} service={service} />
						))}
					</div>
				)}

				<LiveLogTail logs={telemetry.logs} />
			</div>
		</PageFrame>
	);
}
