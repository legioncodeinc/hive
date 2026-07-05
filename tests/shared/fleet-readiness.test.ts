import { isFleetReady, type FleetStatusResponse } from "../../src/shared/fleet-readiness.js";

describe("isFleetReady", () => {
	const readyPayload: FleetStatusResponse = {
		supervisor: "reachable",
		health: "ok",
		asOf: "2026-07-01T12:00:00.000Z",
		daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
	};

	it("ac-AC-7 returns true when aggregate health is degraded and every named peer answered (degraded is UP: honeycomb/nectar boot degraded until a workspace is bound)", () => {
		expect(
			isFleetReady({
				...readyPayload,
				health: "degraded",
				daemons: [
					{ name: "honeycomb", health: "degraded", escalation: null },
					{ name: "nectar", health: "ok", escalation: null },
				],
			}),
		).toBe(true);
	});

	it("ac-AC-7 returns false when aggregate health is unreachable (explicit no response)", () => {
		expect(
			isFleetReady({
				...readyPayload,
				health: "unreachable",
			}),
		).toBe(false);
	});

	it("ac-AC-7 returns false when honeycomb is unreachable despite an answering aggregate", () => {
		expect(
			isFleetReady({
				...readyPayload,
				health: "degraded",
				daemons: [{ name: "honeycomb", health: "unreachable", escalation: null }],
			}),
		).toBe(false);
	});

	it("ac-AC-8 returns false when honeycomb is missing from daemons despite aggregate ok", () => {
		expect(
			isFleetReady({
				supervisor: "reachable",
				health: "ok",
				asOf: "2026-07-01T12:00:00.000Z",
				daemons: [{ name: "nectar", health: "ok", escalation: null }],
			}),
		).toBe(false);
	});
});
