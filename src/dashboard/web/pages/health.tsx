/**
 * The `/health` PAGE — hive PRD-005b (per-service metrics + Deep Lake stats). Registered at
 * `/health` in `registry.tsx`; reachable via the health rail's "health details" link (PRD-005a)
 * or direct navigation. ISS-009: the PRD-005c live log tail is gone — LiveLog belongs only on the
 * Logs page (`#/logs`); a "View logs →" link points there instead.
 *
 * `/health` shares the SAME literal path as hive's own machine-liveness probe (`GET /health`
 * JSON, `server.ts`) — content negotiation on the SERVER (`accept: text/html` → this SPA page,
 * anything else → the liveness JSON) keeps both working at the identical URL (see `gate.ts` /
 * `server.ts` module docs). Client-side navigation (the sidebar link, `navigate()`) never touches
 * the network at all, so this collision only ever matters for a full page load/refresh, which the
 * server-side negotiation resolves.
 *
 * Fed entirely by the SHARED `useFleetTelemetry` hook (SSE-first, REST fail-soft) — no second
 * fetch/poll loop is introduced here (hm-AC-8).
 */

import React from "react";

import { Panel, ViewLogsLink } from "../panels.js";
import { PageFrame } from "../page-frame.js";
import type { PageProps } from "../page-frame.js";
import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "../service-icons.js";
import { useFleetTelemetry, type FleetTelemetryView, type ServiceView } from "../use-fleet-telemetry.js";

// ─────────────────────────────────────────────────────────────────────────────
// hm-AC-1..3: per-service metrics, rendered GENERICALLY (never one service's key names hardcoded).
// ─────────────────────────────────────────────────────────────────────────────

/** Turn a camelCase metric key into a readable label (`filesProcessed` → `files processed`). */
function humanizeMetricKey(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Health page honesty (client-reported gap): the badges below come from doctor's RELAYED
// heartbeats (`useFleetTelemetry`'s SSE/REST snapshot), never a live probe of the daemon's own
// `/health`. A relay can lag or drop, so a tile reading "Deeplake not reached / last seen never"
// can CONTRADICT a currently-healthy daemon the relay simply hasn't reported on yet. This does not
// change the data source (still doctor-relayed, never a direct browser→daemon probe): it only
// labels the badges with WHEN the data is from and whether the relay is currently caught up, so a
// stale/reconnecting snapshot never reads as an unqualified current fact.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render `asOf` (an ISO timestamp) as a short "as of Xs/Xm ago" freshness label, or an honest
 * "no data yet" when there is none. `nowMs` is threaded in (rather than read internally) so the
 * label is a pure function of its inputs and ages correctly on every re-render, which
 * `useFleetTelemetry`'s own 1s clock tick already drives (see its module doc), so this needs no
 * second timer.
 */
export function formatTelemetryFreshness(asOf: string | null, nowMs: number): string {
	if (asOf === null) return "no data yet";
	const ageMs = nowMs - Date.parse(asOf);
	if (Number.isNaN(ageMs)) return "no data yet";
	if (ageMs < 1500) return "as of just now";
	const secs = Math.round(ageMs / 1000);
	if (secs < 60) return `as of ${secs}s ago`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `as of ${mins}m ago`;
	const hours = Math.round(mins / 60);
	return `as of ${hours}h ago`;
}

/**
 * The per-tile freshness annotation: "as of Xs ago via doctor" when the relay is caught up, or an
 * explicit "reconnecting" honesty flag when `useFleetTelemetry`'s `reconnecting` bit is set (a
 * transient blip or an unreachable supervisor, see that hook's `applyRestFallback` doc) so a
 * possibly-stale badge is never mistaken for a live, current reading.
 */
function TelemetryFreshness({ serviceName, asOf, reconnecting }: { readonly serviceName: string; readonly asOf: string | null; readonly reconnecting: boolean }): React.JSX.Element {
	const [nowMs, setNowMs] = React.useState(() => Date.now());
	React.useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	return (
		<div
			data-testid={`health-freshness-${serviceName}`}
			data-reconnecting={reconnecting}
			style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: reconnecting ? "var(--severity-warning)" : "var(--text-tertiary)" }}
		>
			{reconnecting ? "⟳ reconnecting to doctor: may be stale" : `${formatTelemetryFreshness(asOf, nowMs)} via doctor`}
		</div>
	);
}

/** One service's metrics + Deep Lake block (hm-AC-1..3, hm-AC-5..7). Renders whatever keys are present. */
function ServiceHealthCard({ service, asOf, reconnecting }: { readonly service: ServiceView; readonly asOf: string | null; readonly reconnecting: boolean }): React.JSX.Element {
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
				<span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Deeplake</span>
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

			{/* Client robustness (operator-reported gap): this tile's badges are a doctor-RELAYED
			    snapshot, never a live daemon probe (see the module doc). This annotation says WHEN the
			    snapshot is from, and honestly flags a currently-reconnecting relay, so a stale reading
			    is never mistaken for a live one. */}
			<TelemetryFreshness serviceName={service.name} asOf={asOf} reconnecting={reconnecting} />
		</div>
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
 * The `/health` page (PRD-005b). Renders per-service metrics + Deep Lake stats generically from
 * the ONE shared telemetry hook. ISS-009: the verbosity-filtered log tail is gone — the Logs page
 * owns the log experience.
 */
export function HealthPage(_props: PageProps): React.JSX.Element {
	const telemetry = useFleetTelemetry();

	return (
		<PageFrame title="Health" eyebrow={telemetry.source === "sse" ? "live" : telemetry.source === "rest" ? "fallback" : "unavailable"}>
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				{isTelemetryUnavailable(telemetry) ? (
					<Panel title="Fleet metrics">
						<div data-testid="health-telemetry-unavailable" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
							Telemetry unavailable. Waiting for doctor to report the fleet.
						</div>
					</Panel>
				) : (
					<div data-testid="health-service-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
						{telemetry.services.map((service) => (
							<ServiceHealthCard key={service.name} service={service} asOf={telemetry.asOf} reconnecting={telemetry.reconnecting} />
						))}
					</div>
				)}

				{/* ISS-009: the live log tail is gone — the Logs page owns the log experience. */}
				<ViewLogsLink />
			</div>
		</PageFrame>
	);
}
