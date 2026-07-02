/**
 * Bee-loader status STATE model + derivation — hive PRD-004b (state contract) / PRD-004c
 * (derivation). Locked state set (PRD-004 index): `error`, `degraded`, `starting`, `warming`,
 * `active`. This is the SINGLE shared derivation `/buzzing` (PRD-004a) and the health rail
 * (PRD-005a) both resolve through, so a service means the same thing on both surfaces (svg-AC-4).
 *
 * The derivation is a PURE function of a normalized {@link ServiceSignal} plus a small amount of
 * externally-tracked timing context (`now`, `firstActiveAt`) — never a re-derivation of doctor's
 * own health classification, and never reaching out to doctor itself. Both the SSE-fed live path
 * and the `GET /api/fleet-status` fail-soft path normalize into the SAME {@link ServiceSignal} shape
 * before calling {@link deriveServiceState}, which is what makes the derivation source-agnostic
 * (sd-AC-6): the same underlying condition yields the same state regardless of which feed reported it.
 */

import type { FleetHealth, FleetServiceModel, TelemetryFaultReason } from "./fleet-telemetry.js";
import type { FleetDaemonStatus } from "./fleet-readiness.js";

/** The five locked bee-loader states (PRD-004 index, svg-AC-6). No additional/renamed state. */
export const SERVICE_STATES = ["error", "degraded", "starting", "warming", "active"] as const;

/** One of the five locked states. */
export type ServiceState = (typeof SERVICE_STATES)[number];

/** True iff `value` is one of the five locked {@link ServiceState}s (svg-AC-5's fallback guard). */
export function isServiceState(value: string): value is ServiceState {
	return (SERVICE_STATES as readonly string[]).includes(value);
}

/**
 * The minimal, source-agnostic per-service signal the derivation reads (sd-AC-6). Both the rich
 * SSE-fed {@link FleetServiceModel} and the coarser REST `/api/fleet-status` projection normalize
 * into this shape (see {@link fromFleetServiceModel} / {@link fromFleetDaemonStatus}) before the
 * SAME {@link deriveServiceState} call runs, so the rule never branches on which feed produced it.
 */
export interface ServiceSignal {
	readonly health: FleetHealth;
	/** ISO-8601 of the last confirmed check-in, or `null` when the feed does not carry one (e.g. the REST projection). */
	readonly lastSeen: string | null;
	/** Non-null when this tick's telemetry read for this service was skipped/faulted (SSE-only signal; REST fallback never carries one). */
	readonly telemetryFault: TelemetryFaultReason | null;
}

/** Normalize a live SSE {@link FleetServiceModel} into the source-agnostic {@link ServiceSignal}. */
export function fromFleetServiceModel(model: FleetServiceModel): ServiceSignal {
	return { health: model.health, lastSeen: model.lastSeen, telemetryFault: model.telemetryFault };
}

/** Normalize a fail-soft REST {@link FleetDaemonStatus} row into the same {@link ServiceSignal} shape. */
export function fromFleetDaemonStatus(daemon: FleetDaemonStatus): ServiceSignal {
	// The coarse projection carries no `lastSeen`/`telemetryFault` — normalize to the "unknown" values
	// so the SAME derivation function runs on either feed (sd-AC-6/sd-AC-7) rather than a parallel rule.
	return { health: daemon.health, lastSeen: null, telemetryFault: null };
}

/** How long (ms) a service stays `warming` after it is FIRST observed healthy (PRD-004 index's "very recently first-seen"). */
export const DEFAULT_WARMING_GRACE_MS = 10_000;

/** How stale (ms) a reported `lastSeen` may be before the derivation overrides to `error` regardless of the reported health (sd-AC-3). */
export const DEFAULT_STALE_AFTER_MS = 20_000;

/** Input to {@link deriveServiceState}. */
export interface ServiceDerivationInput {
	/**
	 * The service's current normalized signal, or `null` when it is a REGISTERED service that has
	 * not yet appeared in any tick / any projection row (sd-AC-2 — never omitted, never `active`).
	 */
	readonly signal: ServiceSignal | null;
	/** The clock reading (ms) the derivation runs at (injectable for deterministic tests). */
	readonly now: number;
	/**
	 * The wall-clock time (ms) this service was FIRST observed `health === "ok"`, tracked by the
	 * caller across ticks/reconnects (e.g. `use-fleet-telemetry.ts`'s per-service reducer). `null`
	 * when it has never been observed healthy. Kept OUTSIDE this pure function so the function
	 * itself stays a deterministic, unit-testable mapping (sd-AC-1) while the stateful bookkeeping
	 * lives in one place the caller owns.
	 */
	readonly firstActiveAt: number | null;
	/** Override the warming grace window (ms). Defaults to {@link DEFAULT_WARMING_GRACE_MS}. */
	readonly warmingGraceMs?: number;
	/** Override the staleness threshold (ms). Defaults to {@link DEFAULT_STALE_AFTER_MS}. */
	readonly staleAfterMs?: number;
}

/**
 * Derive exactly one of the five locked states from a service's merged registration+runtime
 * signal (PRD-004c derivation table, sd-AC-1). Pure and source-agnostic: the SAME output for the
 * same `(signal, now, firstActiveAt)` triple regardless of whether `signal` came from the SSE
 * stream or the REST fallback projection (sd-AC-6/sd-AC-7). Per-service — this function never
 * looks at any OTHER service's state, so a per-service update can never affect a sibling's derived
 * state (sd-AC-8/sd-AC-9).
 */
export function deriveServiceState(input: ServiceDerivationInput): ServiceState {
	const { signal, now, firstActiveAt } = input;
	const warmingGraceMs = input.warmingGraceMs ?? DEFAULT_WARMING_GRACE_MS;
	const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

	// sd-AC-2: registered but no runtime signal yet (never appeared in a tick/projection row).
	if (signal === null) return "starting";

	// sd-AC-9: an isolated per-service telemetry read fault degrades that service alone.
	if (signal.telemetryFault !== null) return "degraded";

	// sd-AC-3: failed/unreachable, OR a stale last-seen beyond threshold even if the reported
	// health still says otherwise (a safety net for a cached/stale snapshot).
	if (signal.health === "unreachable") return "error";
	if (signal.lastSeen !== null) {
		const lastSeenMs = Date.parse(signal.lastSeen);
		if (Number.isFinite(lastSeenMs) && now - lastSeenMs > staleAfterMs) return "error";
	}

	switch (signal.health) {
		case "degraded":
			// sd-AC-4: up but unhealthy/partial.
			return "degraded";
		case "unknown":
			// Registered, checked in per the poll loop's Contract C convention of a not-yet-bound
			// service reporting `"unknown"` — treated the same as sd-AC-2's never-seen case.
			return "starting";
		case "ok": {
			// sd-AC-5: checked in and healthy. `warming` for a brief grace window right after the
			// FIRST observed transition to healthy, `active` once settled.
			if (firstActiveAt !== null && now - firstActiveAt < warmingGraceMs) return "warming";
			return "active";
		}
		default: {
			// `"unreachable"` is excluded here by the early return above (TS narrows `signal.health`
			// across that guard), so the remaining exhaustive member set is exactly ok/degraded/unknown.
			const exhaustive: never = signal.health;
			return exhaustive;
		}
	}
}

/**
 * Advance the per-service "first observed healthy" bookkeeping {@link deriveServiceState}'s
 * `warming` branch needs (PRD-004 index's "very recently first-seen"). Called once per received
 * signal for a service: returns the SAME `firstActiveAt` when health stays non-`"ok"` or was
 * already marked active-since some earlier time, records `now` the FIRST time health flips to
 * `"ok"`, and resets to `null` if the service leaves `"ok"` (so a later re-activation re-enters the
 * warming grace, honestly reflecting a fresh checked-in-and-healthy transition).
 */
export function nextFirstActiveAt(health: FleetHealth, previous: number | null, now: number): number | null {
	if (health !== "ok") return null;
	return previous ?? now;
}
