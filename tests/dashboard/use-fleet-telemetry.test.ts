/**
 * the-hive PRD-004/PRD-005 — the shared fleet-telemetry view-model's PURE reducer steps
 * (`applyRegisteredNames`, `applySseEvent`, `applyRestFallback`, `appendLogs`,
 * `deriveServiceViews`) plus the verbosity filter (PRD-005c). These are exercised directly
 * (no live `EventSource`/`fetch`) so the coverage does not depend on jsdom's SSE support.
 * Hook-level (mount/unmount + fetch fallback) behavior is covered in
 * `use-fleet-telemetry-hook.test.tsx` under the jsdom environment.
 */

import {
	appendLogs,
	applyRegisteredNames,
	applyRestFallback,
	applySseEvent,
	createInitialTelemetryState,
	deriveServiceViews,
	filterLogsByVerbosity,
	LOG_RING_BUFFER_CAP,
	toFleetTelemetryView,
} from "../../src/dashboard/web/use-fleet-telemetry.js";
import type { FleetLogEntry, FleetTelemetryEvent } from "../../src/shared/fleet-telemetry.js";
import type { FleetStatusResponse } from "../../src/shared/fleet-readiness.js";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");

function logLine(overrides: Partial<FleetLogEntry> = {}): FleetLogEntry {
	return { service: "honeycomb", ts: "2026-07-01T11:59:59.000Z", level: "info", message: "hi", ...overrides };
}

describe("applyRegisteredNames (bz-AC-1/bz-AC-2, hr-AC-1)", () => {
	it("a registered service with no telemetry yet still appears (as a name), never omitted", () => {
		const state = applyRegisteredNames(createInitialTelemetryState(), ["honeycomb", "hivenectar", "never-seen-svc"]);
		const views = deriveServiceViews(state, NOW);
		expect(views.map((v) => v.name)).toEqual(["honeycomb", "hivenectar", "never-seen-svc"]);
		expect(views.find((v) => v.name === "never-seen-svc")?.state).toBe("starting");
	});

	it("de-duplicates and preserves first-seen order across repeated calls", () => {
		let state = applyRegisteredNames(createInitialTelemetryState(), ["a", "b"]);
		state = applyRegisteredNames(state, ["b", "c"]);
		expect(state.registeredNames).toEqual(["a", "b", "c"]);
	});
});

describe("applySseEvent (bz-AC-4, hr-AC-3, sd-AC-8/sd-AC-9 isolation)", () => {
	it("merges every service in the event, deriving each one's state independently", () => {
		const event: FleetTelemetryEvent = {
			asOf: "2026-07-01T12:00:00.000Z",
			services: [
				{ name: "honeycomb", health: "ok", lastSeen: "2026-07-01T11:59:59.900Z", metrics: { actionsTaken: 4 }, deeplake: null, telemetryFault: null },
				{ name: "hivenectar", health: "unreachable", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null },
			],
			logs: [],
		};
		const state = applySseEvent(createInitialTelemetryState(), event, NOW);
		const view = toFleetTelemetryView(state, NOW);
		expect(view.source).toBe("sse");
		expect(view.services.find((s) => s.name === "hivenectar")?.state).toBe("error");
		// honeycomb's own state is unaffected by hivenectar being unreachable (per-service isolation).
		expect(view.services.find((s) => s.name === "honeycomb")?.state).not.toBe("error");
	});

	it("a subsequent event updates ONLY the changed service, leaving the other's derived state untouched", () => {
		const base: FleetTelemetryEvent = {
			asOf: "2026-07-01T12:00:00.000Z",
			services: [
				{ name: "honeycomb", health: "ok", lastSeen: "2026-07-01T11:59:00.000Z", metrics: {}, deeplake: null, telemetryFault: null },
				{ name: "hivenectar", health: "ok", lastSeen: "2026-07-01T11:59:00.000Z", metrics: {}, deeplake: null, telemetryFault: null },
			],
			logs: [],
		};
		let state = applySseEvent(createInitialTelemetryState(), base, NOW - 60_000);
		const before = toFleetTelemetryView(state, NOW).services.find((s) => s.name === "honeycomb");

		const next: FleetTelemetryEvent = {
			asOf: "2026-07-01T12:00:10.000Z",
			services: [{ name: "hivenectar", health: "unreachable", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null }],
			logs: [],
		};
		state = applySseEvent(state, next, NOW);
		const after = toFleetTelemetryView(state, NOW).services.find((s) => s.name === "honeycomb");
		expect(after?.state).toBe(before?.state);
	});
});

describe("applyRestFallback (bz-AC-5, hr-AC-4, hm-AC-10)", () => {
	it("retains previously-known metrics/deeplake (the REST projection carries neither)", () => {
		const sseState = applySseEvent(
			createInitialTelemetryState(),
			{
				asOf: "2026-07-01T12:00:00.000Z",
				services: [{ name: "honeycomb", health: "ok", lastSeen: "2026-07-01T11:59:59.000Z", metrics: { actionsTaken: 7 }, deeplake: { connected: true, lastCommunicationAt: "x" }, telemetryFault: null }],
				logs: [],
			},
			NOW - 5000,
		);

		const restStatus: FleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:00:05.000Z",
			daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
		};
		const restState = applyRestFallback(sseState, restStatus, NOW);
		const view = toFleetTelemetryView(restState, NOW);
		expect(view.source).toBe("rest");
		expect(view.services.find((s) => s.name === "honeycomb")?.metrics.actionsTaken).toBe(7);
		expect(view.services.find((s) => s.name === "honeycomb")?.deeplake?.connected).toBe(true);
	});

	it("a supervisor-unreachable projection flips the source without throwing", () => {
		const state = applyRestFallback(createInitialTelemetryState(), { supervisor: "unreachable", daemons: [] }, NOW);
		expect(toFleetTelemetryView(state, NOW).source).toBe("rest");
	});

	it("treats the response as a SNAPSHOT: a daemon omitted from a later response loses its stale signal", () => {
		const firstStatus: FleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [
				{ name: "honeycomb", health: "ok", escalation: null },
				{ name: "hivenectar", health: "ok", escalation: null },
			],
		};
		const afterFirst = applyRestFallback(createInitialTelemetryState(), firstStatus, NOW - 60_000);
		expect(toFleetTelemetryView(afterFirst, NOW).services.find((s) => s.name === "hivenectar")?.state).toBe("active");

		// hivenectar disappears from the projection entirely (e.g. deregistered or dropped by
		// hivedoctor). Its NAME must survive (never omitted from the view), but its runtime signal
		// must not: it falls back to the registered-but-silent derivation instead of staying active.
		const secondStatus: FleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:01:00.000Z",
			daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
		};
		const afterSecond = applyRestFallback(afterFirst, secondStatus, NOW);
		const view = toFleetTelemetryView(afterSecond, NOW);
		const hivenectar = view.services.find((s) => s.name === "hivenectar");
		expect(hivenectar).toBeDefined();
		expect(hivenectar?.state).toBe("starting");
		expect(hivenectar?.health).toBeNull();
		expect(view.services.find((s) => s.name === "honeycomb")?.state).toBe("active");
	});

	it("snapshot rebuild still preserves warming bookkeeping for daemons PRESENT in the response", () => {
		const status: FleetStatusResponse = {
			supervisor: "reachable",
			health: "ok",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
		};
		// First observed healthy at NOW - 5s: still inside the warming grace window...
		const afterFirst = applyRestFallback(createInitialTelemetryState(), status, NOW - 5_000);
		expect(toFleetTelemetryView(afterFirst, NOW - 5_000).services[0]?.state).toBe("warming");
		// ...and a later snapshot must carry `firstActiveAt` forward (not restart the window).
		const afterSecond = applyRestFallback(afterFirst, status, NOW);
		expect(toFleetTelemetryView(afterSecond, NOW + 6_000).services[0]?.state).toBe("active");
	});
});

describe("appendLogs — bounded ring buffer (lg-AC-6/lg-AC-8)", () => {
	it("caps at LOG_RING_BUFFER_CAP, dropping the OLDEST lines first", () => {
		const existing = Array.from({ length: LOG_RING_BUFFER_CAP }, (_, i) => logLine({ message: `old-${i}` }));
		const incoming = [logLine({ message: "new-1" }), logLine({ message: "new-2" })];
		const result = appendLogs(existing, incoming);
		expect(result).toHaveLength(LOG_RING_BUFFER_CAP);
		expect(result[result.length - 1]?.message).toBe("new-2");
		expect(result.some((l) => l.message === "old-0")).toBe(false);
	});

	it("never replays full history — appending is additive over the bounded window only", () => {
		const result = appendLogs([logLine({ message: "a" })], [logLine({ message: "b" })]);
		expect(result.map((l) => l.message)).toEqual(["a", "b"]);
	});
});

describe("filterLogsByVerbosity (lg-AC-4/lg-AC-5)", () => {
	const logs = [logLine({ level: "debug", message: "d" }), logLine({ level: "info", message: "i" }), logLine({ level: "warn", message: "w" }), logLine({ level: "error", message: "e" })];

	it("shows lines AT OR ABOVE the selected level", () => {
		expect(filterLogsByVerbosity(logs, "warn").map((l) => l.message)).toEqual(["w", "e"]);
		expect(filterLogsByVerbosity(logs, "debug").map((l) => l.message)).toEqual(["d", "i", "w", "e"]);
		expect(filterLogsByVerbosity(logs, "error").map((l) => l.message)).toEqual(["e"]);
	});

	it("treats an unrecognized level as info-rank rather than dropping it silently", () => {
		const weird = [logLine({ level: "trace", message: "t" })];
		expect(filterLogsByVerbosity(weird, "info").map((l) => l.message)).toEqual(["t"]);
		expect(filterLogsByVerbosity(weird, "error").map((l) => l.message)).toEqual([]);
	});
});
