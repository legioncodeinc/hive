import { isFleetReady, type FleetStatusResponse } from "../../src/shared/fleet-readiness.js";

describe("isFleetReady", () => {
	const readyPayload: FleetStatusResponse = {
		supervisor: "reachable",
		health: "ok",
		asOf: "2026-07-01T12:00:00.000Z",
		daemons: [{ name: "honeycomb", health: "ok", escalation: null }],
	};

	it("ac-AC-7 returns false when aggregate health is degraded even if every named peer row is ok", () => {
		expect(
			isFleetReady({
				...readyPayload,
				health: "degraded",
				daemons: [
					{ name: "honeycomb", health: "ok", escalation: null },
					{ name: "nectar", health: "ok", escalation: null },
				],
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
