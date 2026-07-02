/**
 * The SHARED fleet-telemetry view-model hook — the-hive PRD-004/PRD-005. One hook, consumed by
 * `/buzzing` (PRD-004a), the health rail (PRD-005a), and the `/health` page (PRD-005b/PRD-005c),
 * so the SSE-first/REST-fallback wiring, the registered-name enumeration, and the bounded log
 * ring buffer are each written exactly once (per the implementation brief), not duplicated per
 * consumer.
 *
 * Sourcing precedence (bz-AC-4/bz-AC-5/bz-AC-6, hr-AC-3/hr-AC-4/hr-AC-5):
 *   1. `EventSource("/api/telemetry/stream")` — the same-origin relay of hivedoctor's real SSE
 *      stream (`telemetry-proxy.ts`). Live, near-real-time. `EventSource` auto-reconnects on its
 *      own after a drop (the browser's built-in behavior), so "resumes without a manual refresh"
 *      falls out of the platform rather than hand-rolled reconnect logic.
 *   2. `GET /api/fleet-status` (PRD-002a), polled — the fail-soft fallback the whole time SSE is
 *      unavailable/erroring. Coarser (no metrics/Deep Lake/lastSeen), but keeps every tile/pill
 *      rendering rather than blanking.
 *
 * Every state-mutating step below is a PURE, exported function (`applyRegisteredNames`,
 * `applySseEvent`, `applyRestFallback`, `appendLogs`, `deriveServiceViews`) so the derivation and
 * bookkeeping are unit-testable without a real `EventSource` (jsdom has none — the hook itself
 * degrades to the REST path in that environment, exactly like `wire.ts`'s `logsStream`).
 *
 * Memory-bounded (parent index constraint, lg-AC-6): `logs` is a capped ring buffer
 * ({@link LOG_RING_BUFFER_CAP}), oldest-dropped; `services` holds only CURRENT per-service state,
 * never a history series (hr-AC-7).
 */

import React from "react";

import {
	FLEET_TELEMETRY_EVENT_NAME,
	parseFleetTelemetryEvent,
	type FleetDeeplakeStats,
	type FleetLogEntry,
	type FleetTelemetryEvent,
	type ServiceMetrics,
	type TelemetryFaultReason,
} from "../../shared/fleet-telemetry.js";
import type { FleetHealth, FleetStatusResponse } from "../../shared/fleet-readiness.js";
import {
	deriveServiceState,
	fromFleetDaemonStatus,
	fromFleetServiceModel,
	nextFirstActiveAt,
	type ServiceSignal,
	type ServiceState,
} from "../../shared/service-status.js";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints (same-origin only — hr-AC-6/sd-AC-6: the browser never reaches hivedoctor directly).
// ─────────────────────────────────────────────────────────────────────────────

const REGISTERED_SERVICES_ENDPOINT = "/api/registered-services" as const;
const TELEMETRY_STREAM_ENDPOINT = "/api/telemetry/stream" as const;
const FLEET_STATUS_ENDPOINT = "/api/fleet-status" as const;

/** How often the REST fallback polls while the SSE stream is unavailable (ms). */
const DEFAULT_REST_POLL_MS = 2000;

/** The bounded log ring-buffer cap (lg-AC-6/lg-AC-8): older lines drop rather than accumulate. */
export const LOG_RING_BUFFER_CAP = 500;

// ─────────────────────────────────────────────────────────────────────────────
// The public per-service + view shapes every consumer renders from.
// ─────────────────────────────────────────────────────────────────────────────

/** One service's rendered view-model: its derived loader state plus whatever raw telemetry is known. */
export interface ServiceView {
	readonly name: string;
	readonly state: ServiceState;
	/** The raw hivedoctor health, or `null` before any signal has been observed for this service. */
	readonly health: FleetHealth | null;
	readonly lastSeen: string | null;
	/** Schema-tolerant per-service counters (PRD-005b) — `{}` until telemetry reports any. */
	readonly metrics: ServiceMetrics;
	readonly deeplake: FleetDeeplakeStats | null;
	readonly telemetryFault: TelemetryFaultReason | null;
}

export type TelemetrySource = "sse" | "rest" | "none";

/** The shared view-model {@link useFleetTelemetry} returns. */
export interface FleetTelemetryView {
	readonly services: readonly ServiceView[];
	/** A bounded, newest-appended log tail (PRD-005c) — never the full history. */
	readonly logs: readonly FleetLogEntry[];
	readonly source: TelemetrySource;
	readonly asOf: string | null;
}

export const EMPTY_FLEET_TELEMETRY_VIEW: FleetTelemetryView = { services: [], logs: [], source: "none", asOf: null };

// ─────────────────────────────────────────────────────────────────────────────
// Internal state + the pure reducer steps (unit-testable without a live EventSource).
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceRuntime {
	readonly signal: ServiceSignal;
	readonly metrics: ServiceMetrics;
	readonly deeplake: FleetDeeplakeStats | null;
	readonly firstActiveAt: number | null;
}

/** @internal exported only for tests. */
export interface TelemetryState {
	readonly registeredNames: readonly string[];
	readonly services: ReadonlyMap<string, ServiceRuntime>;
	readonly logs: readonly FleetLogEntry[];
	readonly source: TelemetrySource;
	readonly asOf: string | null;
}

/** The initial, empty state before any registration/telemetry has arrived. */
export function createInitialTelemetryState(registeredNames: readonly string[] = []): TelemetryState {
	return { registeredNames, services: new Map(), logs: [], source: "none", asOf: null };
}

/** Union a freshly-observed name into the tracked registered set, preserving first-seen order. */
function withKnownName(names: readonly string[], name: string): readonly string[] {
	return names.includes(name) ? names : [...names, name];
}

/**
 * Merge the full registered-name enumeration (`GET /api/registered-services`) into state
 * (bz-AC-1/bz-AC-2, hr-AC-1). Never drops a name already tracked from telemetry that this
 * enumeration happens not to list (defense against a stale/partial registry read).
 */
export function applyRegisteredNames(state: TelemetryState, names: readonly string[]): TelemetryState {
	let next = state.registeredNames;
	for (const name of names) next = withKnownName(next, name);
	return next === state.registeredNames ? state : { ...state, registeredNames: next };
}

/** Append new log lines, capped at {@link LOG_RING_BUFFER_CAP} with the OLDEST dropped first (lg-AC-6/lg-AC-8). */
export function appendLogs(existing: readonly FleetLogEntry[], incoming: readonly FleetLogEntry[]): readonly FleetLogEntry[] {
	if (incoming.length === 0) return existing;
	const merged = [...existing, ...incoming];
	return merged.length > LOG_RING_BUFFER_CAP ? merged.slice(merged.length - LOG_RING_BUFFER_CAP) : merged;
}

/** Apply one live `fleet-telemetry` SSE event (bz-AC-4, hr-AC-3, sd-AC-8/sd-AC-9 per-service isolation). */
export function applySseEvent(state: TelemetryState, event: FleetTelemetryEvent, now: number): TelemetryState {
	let names = state.registeredNames;
	const services = new Map(state.services);

	for (const model of event.services) {
		names = withKnownName(names, model.name);
		const signal = fromFleetServiceModel(model);
		const previous = services.get(model.name);
		services.set(model.name, {
			signal,
			metrics: model.metrics,
			deeplake: model.deeplake,
			firstActiveAt: nextFirstActiveAt(model.health, previous?.firstActiveAt ?? null, now),
		});
	}

	return {
		registeredNames: names,
		services,
		logs: appendLogs(state.logs, event.logs),
		source: "sse",
		asOf: event.asOf,
	};
}

/**
 * Apply one `GET /api/fleet-status` fail-soft projection (bz-AC-5, hr-AC-4). The coarse
 * projection carries no metrics/Deep Lake/lastSeen, so existing per-service metrics/Deep Lake
 * readings are RETAINED (hm-AC-10's "last known metrics") — only the derived health-driving
 * signal is refreshed.
 *
 * The response is a SNAPSHOT, not a patch: `services` is rebuilt from `status.daemons` alone, so
 * a daemon missing from a later response loses its stale `signal`/`firstActiveAt` and falls back
 * to the registered-but-silent derivation (`starting`) instead of staying `active`/`degraded`
 * forever. Its NAME is still retained via `registeredNames`, so the row never disappears.
 */
export function applyRestFallback(state: TelemetryState, status: FleetStatusResponse, now: number): TelemetryState {
	if (status.supervisor !== "reachable") {
		// Supervisor itself unreachable: no per-service signal to apply, but the source flips so
		// consumers can show a "telemetry unavailable" fail-soft state rather than a stale "sse" label.
		return { ...state, source: "rest" };
	}

	let names = state.registeredNames;
	const services = new Map<string, ServiceRuntime>();

	for (const daemon of status.daemons) {
		names = withKnownName(names, daemon.name);
		const signal = fromFleetDaemonStatus(daemon);
		const previous = state.services.get(daemon.name);
		services.set(daemon.name, {
			signal,
			metrics: previous?.metrics ?? {},
			deeplake: previous?.deeplake ?? null,
			firstActiveAt: nextFirstActiveAt(daemon.health, previous?.firstActiveAt ?? null, now),
		});
	}

	return { registeredNames: names, services, logs: state.logs, source: "rest", asOf: status.asOf };
}

/** Build the rendered per-service views for every KNOWN name, in first-seen order (never omitted, sd-AC-2/bz-AC-2). */
export function deriveServiceViews(state: TelemetryState, now: number): readonly ServiceView[] {
	return state.registeredNames.map((name) => {
		const runtime = state.services.get(name);
		const derived = deriveServiceState({
			signal: runtime?.signal ?? null,
			now,
			firstActiveAt: runtime?.firstActiveAt ?? null,
		});
		return {
			name,
			state: derived,
			health: runtime?.signal.health ?? null,
			lastSeen: runtime?.signal.lastSeen ?? null,
			metrics: runtime?.metrics ?? {},
			deeplake: runtime?.deeplake ?? null,
			telemetryFault: runtime?.signal.telemetryFault ?? null,
		};
	});
}

/** Project internal {@link TelemetryState} into the public {@link FleetTelemetryView}. */
export function toFleetTelemetryView(state: TelemetryState, now: number): FleetTelemetryView {
	return { services: deriveServiceViews(state, now), logs: state.logs, source: state.source, asOf: state.asOf };
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook: wires the pure steps above to EventSource + fetch effects.
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link useFleetTelemetry}. */
export interface UseFleetTelemetryOptions {
	/** Override the REST-fallback poll interval (ms). Defaults to {@link DEFAULT_REST_POLL_MS}. */
	readonly restPollMs?: number;
}

/**
 * The shared fleet-telemetry hook (see module doc for the sourcing precedence). Every consumer
 * mounts its own instance; the underlying SSE/REST wiring is identical code shared via this one
 * function rather than re-implemented per screen.
 */
export function useFleetTelemetry(options: UseFleetTelemetryOptions = {}): FleetTelemetryView {
	const restPollMs = options.restPollMs ?? DEFAULT_REST_POLL_MS;
	const [state, setState] = React.useState<TelemetryState>(() => createInitialTelemetryState());
	const [now, setNow] = React.useState(() => Date.now());

	// `deriveServiceState` is time-dependent (the warming grace window, the stale-`lastSeen`
	// override), so the view must recompute on a clock tick too, not only on incoming data:
	// a quiet-but-open SSE stream would otherwise freeze a service in `warming`, or never age a
	// stale `lastSeen` into `error`, until some unrelated state update happened to re-render.
	React.useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	// bz-AC-1/bz-AC-2/hr-AC-1: enumerate the FULL registered-service set once on mount, so a tile
	// exists for a registered-but-silent service even before its first telemetry tick.
	React.useEffect(() => {
		let alive = true;
		void (async (): Promise<void> => {
			try {
				const response = await fetch(REGISTERED_SERVICES_ENDPOINT);
				if (!response.ok) return;
				const body = (await response.json()) as { readonly names?: unknown };
				if (!alive || !Array.isArray(body.names)) return;
				const names = body.names.filter((n): n is string => typeof n === "string");
				if (names.length > 0) setState((current) => applyRegisteredNames(current, names));
			} catch {
				// Fail soft: no enumeration; tiles simply populate as telemetry/fallback rows arrive.
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	// The SSE-first / REST-fallback data path.
	React.useEffect(() => {
		let alive = true;
		let restIntervalId: ReturnType<typeof setInterval> | null = null;

		function stopRestFallback(): void {
			if (restIntervalId !== null) {
				clearInterval(restIntervalId);
				restIntervalId = null;
			}
		}

		function startRestFallback(): void {
			if (restIntervalId !== null) return;
			const tick = async (): Promise<void> => {
				try {
					const response = await fetch(FLEET_STATUS_ENDPOINT);
					const body = (await response.json()) as FleetStatusResponse;
					if (!alive) return;
					setState((current) => applyRestFallback(current, body, Date.now()));
				} catch {
					// Keep the last-known view; the next tick retries (bz-AC-5/hr-AC-4 fail-soft).
				}
			};
			void tick();
			restIntervalId = setInterval(() => void tick(), restPollMs);
		}

		// jsdom (this repo's test environment) has no `EventSource`; degrading straight to the REST
		// path here mirrors `wire.ts`'s `logsStream` guard and keeps this hook exercisable in tests.
		const EventSourceCtor = (globalThis as { EventSource?: typeof EventSource }).EventSource;
		if (EventSourceCtor === undefined) {
			startRestFallback();
			return () => {
				alive = false;
				stopRestFallback();
			};
		}

		let source: EventSource | null = null;
		const onTelemetry = (event: MessageEvent): void => {
			if (!alive) return;
			const data = typeof event.data === "string" ? event.data : String(event.data);
			const parsed = parseFleetTelemetryEvent(data);
			if (parsed === null) return;
			// A good frame means the stream is up; stop the fallback poll (bz-AC-6/hr-AC-5: resumed
			// live updates without a manual refresh).
			stopRestFallback();
			setState((current) => applySseEvent(current, parsed, Date.now()));
		};
		// bz-AC-5/hr-AC-4: any stream error (including a drop) falls back to polling REST while
		// `EventSource`'s own built-in reconnect keeps retrying the stream in the background.
		const onError = (): void => startRestFallback();

		try {
			source = new EventSourceCtor(TELEMETRY_STREAM_ENDPOINT);
			source.addEventListener(FLEET_TELEMETRY_EVENT_NAME, onTelemetry as EventListener);
			source.addEventListener("error", onError);
		} catch {
			startRestFallback();
		}

		return () => {
			alive = false;
			stopRestFallback();
			try {
				source?.removeEventListener(FLEET_TELEMETRY_EVENT_NAME, onTelemetry as EventListener);
				source?.removeEventListener("error", onError);
				source?.close();
			} catch {
				// Closing an already-closed/errored source must never throw into unmount.
			}
		};
	}, [restPollMs]);

	return React.useMemo(() => toFleetTelemetryView(state, now), [state, now]);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-005c: log verbosity filtering over the SAME bounded buffer (no second stream, no re-fetch).
// ─────────────────────────────────────────────────────────────────────────────

/** The four selectable verbosity levels (lg-AC-4), ordered least→most severe. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Rank an arbitrary (free-form, per hivedoctor's schema) log level string; an unrecognized level defaults to `info`'s rank. */
function logLevelRank(level: string): number {
	const idx = LOG_LEVELS.indexOf(level.trim().toLowerCase() as LogLevel);
	return idx === -1 ? LOG_LEVELS.indexOf("info") : idx;
}

/** Filter a log buffer to lines AT OR ABOVE `minLevel` (lg-AC-4/lg-AC-5) — a view filter, never a re-fetch. */
export function filterLogsByVerbosity(logs: readonly FleetLogEntry[], minLevel: LogLevel): readonly FleetLogEntry[] {
	const minRank = LOG_LEVELS.indexOf(minLevel);
	return logs.filter((entry) => logLevelRank(entry.level) >= minRank);
}
