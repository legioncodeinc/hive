/**
 * PRD-004c — the status-derivation table (sd-AC-1..9). Pure-function tests: no live doctor,
 * no SSE, no fetch. Also covers PRD-004b's state-set contract (svg-AC-6, via `isServiceState`).
 */

import {
	deriveServiceState,
	fromFleetDaemonStatus,
	fromFleetServiceModel,
	isServiceState,
	nextFirstActiveAt,
	SERVICE_STATES,
	type ServiceSignal,
} from "../../src/shared/service-status.js";
import type { FleetServiceModel } from "../../src/shared/fleet-telemetry.js";
import type { FleetDaemonStatus } from "../../src/shared/fleet-readiness.js";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");

function signal(overrides: Partial<ServiceSignal> = {}): ServiceSignal {
	return { health: "ok", lastSeen: new Date(NOW).toISOString(), telemetryFault: null, ...overrides };
}

describe("SERVICE_STATES / isServiceState (svg-AC-6)", () => {
	it("enumerates exactly the five locked states", () => {
		expect(SERVICE_STATES).toEqual(["error", "degraded", "starting", "warming", "active"]);
	});

	it.each(SERVICE_STATES)("isServiceState(%s) is true", (state) => {
		expect(isServiceState(state)).toBe(true);
	});

	it("isServiceState rejects an unknown value (svg-AC-5's fallback guard)", () => {
		expect(isServiceState("booting")).toBe(false);
		expect(isServiceState("")).toBe(false);
	});
});

describe("deriveServiceState — the full state table (sd-AC-1..5)", () => {
	it("sd-AC-2: a registered service with no runtime signal yet derives to starting, never omitted/active", () => {
		expect(deriveServiceState({ signal: null, now: NOW, firstActiveAt: null })).toBe("starting");
	});

	it("sd-AC-2 (via Contract C's health=unknown for a not-yet-bound service): also derives to starting", () => {
		expect(deriveServiceState({ signal: signal({ health: "unknown", lastSeen: null }), now: NOW, firstActiveAt: null })).toBe("starting");
	});

	it("sd-AC-9: an isolated telemetry-read fault derives to degraded regardless of reported health", () => {
		expect(deriveServiceState({ signal: signal({ health: "ok", telemetryFault: "locked" }), now: NOW, firstActiveAt: NOW })).toBe("degraded");
		expect(deriveServiceState({ signal: signal({ health: "degraded", telemetryFault: "missing" }), now: NOW, firstActiveAt: null })).toBe("degraded");
	});

	it("sd-AC-3: unreachable health derives to error", () => {
		expect(deriveServiceState({ signal: signal({ health: "unreachable" }), now: NOW, firstActiveAt: null })).toBe("error");
	});

	it("sd-AC-3: a stale last-seen beyond threshold derives to error even when health still says ok", () => {
		const staleSignal = signal({ health: "ok", lastSeen: new Date(NOW - 60_000).toISOString() });
		expect(deriveServiceState({ signal: staleSignal, now: NOW, firstActiveAt: NOW - 60_000, staleAfterMs: 20_000 })).toBe("error");
	});

	it("a fresh (non-stale) last-seen with health ok is NOT forced to error", () => {
		const freshSignal = signal({ health: "ok", lastSeen: new Date(NOW - 1_000).toISOString() });
		expect(deriveServiceState({ signal: freshSignal, now: NOW, firstActiveAt: NOW - 30_000, staleAfterMs: 20_000 })).not.toBe("error");
	});

	it("sd-AC-4: degraded health derives to degraded", () => {
		expect(deriveServiceState({ signal: signal({ health: "degraded" }), now: NOW, firstActiveAt: null })).toBe("degraded");
	});

	it("sd-AC-5: healthy but within the warming grace window derives to warming", () => {
		const firstActiveAt = NOW - 2_000;
		expect(deriveServiceState({ signal: signal({ health: "ok" }), now: NOW, firstActiveAt, warmingGraceMs: 10_000 })).toBe("warming");
	});

	it("sd-AC-5: healthy and settled (past the warming grace) derives to active", () => {
		const firstActiveAt = NOW - 60_000;
		expect(deriveServiceState({ signal: signal({ health: "ok" }), now: NOW, firstActiveAt, warmingGraceMs: 10_000 })).toBe("active");
	});

	it("sd-AC-5: healthy with no recorded firstActiveAt (never tracked) settles straight to active", () => {
		expect(deriveServiceState({ signal: signal({ health: "ok" }), now: NOW, firstActiveAt: null })).toBe("active");
	});

	it("sd-AC-1: every derivation produces exactly one of the five locked states", () => {
		const cases: Array<ReturnType<typeof deriveServiceState>> = [
			deriveServiceState({ signal: null, now: NOW, firstActiveAt: null }),
			deriveServiceState({ signal: signal({ health: "unknown" }), now: NOW, firstActiveAt: null }),
			deriveServiceState({ signal: signal({ health: "unreachable" }), now: NOW, firstActiveAt: null }),
			deriveServiceState({ signal: signal({ health: "degraded" }), now: NOW, firstActiveAt: null }),
			deriveServiceState({ signal: signal({ health: "ok" }), now: NOW, firstActiveAt: NOW }),
			deriveServiceState({ signal: signal({ health: "ok" }), now: NOW, firstActiveAt: NOW - 60_000 }),
		];
		for (const c of cases) expect(isServiceState(c)).toBe(true);
	});
});

describe("deriveServiceState — per-service isolation (sd-AC-8/sd-AC-9)", () => {
	it("one service's derivation never reads or is influenced by another service's data", () => {
		// The function's only inputs are this ONE service's signal + timing context — there is no
		// way for a sibling's state to leak in, proven simply by the signature never accepting one.
		const a = deriveServiceState({ signal: signal({ health: "unreachable" }), now: NOW, firstActiveAt: null });
		const b = deriveServiceState({ signal: signal({ health: "ok" }), now: NOW, firstActiveAt: NOW - 60_000 });
		expect(a).toBe("error");
		expect(b).toBe("active");
	});
});

describe("source-agnostic normalization (sd-AC-6/sd-AC-7)", () => {
	it("the SSE-shaped and REST-shaped normalizers yield the identical derived state for the same condition", () => {
		const model: FleetServiceModel = {
			name: "honeycomb",
			health: "degraded",
			lastSeen: new Date(NOW).toISOString(),
			metrics: {},
			deeplake: null,
			telemetryFault: null,
		};
		const daemon: FleetDaemonStatus = { name: "honeycomb", health: "degraded", escalation: null };

		const fromSse = deriveServiceState({ signal: fromFleetServiceModel(model), now: NOW, firstActiveAt: null });
		const fromRest = deriveServiceState({ signal: fromFleetDaemonStatus(daemon), now: NOW, firstActiveAt: null });
		expect(fromSse).toBe("degraded");
		expect(fromRest).toBe("degraded");
	});

	it("sd-AC-7: switching from SSE to REST does not spuriously change state when the underlying condition is unchanged", () => {
		const okModel: FleetServiceModel = { name: "nectar", health: "ok", lastSeen: new Date(NOW).toISOString(), metrics: {}, deeplake: null, telemetryFault: null };
		const okDaemon: FleetDaemonStatus = { name: "nectar", health: "ok", escalation: null };
		const firstActiveAt = NOW - 60_000;

		const viaSse = deriveServiceState({ signal: fromFleetServiceModel(okModel), now: NOW, firstActiveAt });
		const viaRest = deriveServiceState({ signal: fromFleetDaemonStatus(okDaemon), now: NOW, firstActiveAt });
		expect(viaSse).toBe(viaRest);
	});
});

describe("nextFirstActiveAt", () => {
	it("records `now` the first time health flips to ok", () => {
		expect(nextFirstActiveAt("ok", null, NOW)).toBe(NOW);
	});

	it("preserves the earlier firstActiveAt across subsequent healthy ticks", () => {
		expect(nextFirstActiveAt("ok", NOW - 5000, NOW)).toBe(NOW - 5000);
	});

	it("resets to null once health leaves ok, so a later re-activation re-enters warming", () => {
		expect(nextFirstActiveAt("degraded", NOW - 5000, NOW)).toBeNull();
		expect(nextFirstActiveAt("unreachable", NOW - 5000, NOW)).toBeNull();
	});
});
