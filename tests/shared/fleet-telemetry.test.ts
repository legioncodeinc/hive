/**
 * Shared fleet-telemetry shape + defensive-parse tests (mirrors doctor's Contract C).
 */

import { FLEET_TELEMETRY_EVENT_NAME, parseFleetTelemetryEvent } from "../../src/shared/fleet-telemetry.js";

const VALID_EVENT = {
	asOf: "2026-07-01T12:00:00.000Z",
	services: [
		{
			name: "honeycomb",
			health: "ok",
			lastSeen: "2026-07-01T11:59:59.000Z",
			metrics: { actionsTaken: 4, filesProcessed: 12, memoriesCreated: 3 },
			deeplake: { connected: true, lastCommunicationAt: "2026-07-01T11:59:00.000Z" },
			telemetryFault: null,
		},
	],
	logs: [{ service: "honeycomb", ts: "2026-07-01T11:59:59.500Z", level: "info", message: "hello" }],
};

describe("FLEET_TELEMETRY_EVENT_NAME", () => {
	it("is the one SSE event name doctor's stream emits", () => {
		expect(FLEET_TELEMETRY_EVENT_NAME).toBe("fleet-telemetry");
	});
});

describe("parseFleetTelemetryEvent", () => {
	it("parses a well-formed frame body", () => {
		const parsed = parseFleetTelemetryEvent(JSON.stringify(VALID_EVENT));
		expect(parsed).not.toBeNull();
		expect(parsed?.services[0]?.name).toBe("honeycomb");
		expect(parsed?.services[0]?.metrics.filesProcessed).toBe(12);
		expect(parsed?.logs).toHaveLength(1);
	});

	it("returns null for invalid JSON rather than throwing", () => {
		expect(parseFleetTelemetryEvent("{not json")).toBeNull();
	});

	it("returns null for well-formed JSON that does not match the schema", () => {
		expect(parseFleetTelemetryEvent(JSON.stringify({ hello: "world" }))).toBeNull();
	});

	it("returns null when a service row is missing a required field", () => {
		const broken = { ...VALID_EVENT, services: [{ ...VALID_EVENT.services[0], health: "not-a-real-health" }] };
		expect(parseFleetTelemetryEvent(JSON.stringify(broken))).toBeNull();
	});

	it("accepts a schema-tolerant metrics set with a totally different key set (nectar's five keys)", () => {
		const nectarEvent = {
			asOf: "2026-07-01T12:00:00.000Z",
			services: [
				{
					name: "nectar",
					health: "ok",
					lastSeen: "2026-07-01T11:59:59.000Z",
					metrics: {
						filesRegistered: 10,
						nectarsMinted: 2,
						descriptionsGenerated: 2,
						hiveGraphVersions: 1,
						embeddingsComputed: 100,
					},
					deeplake: null,
					telemetryFault: null,
				},
			],
			logs: [],
		};
		const parsed = parseFleetTelemetryEvent(JSON.stringify(nectarEvent));
		expect(parsed?.services[0]?.metrics.embeddingsComputed).toBe(100);
	});
});
