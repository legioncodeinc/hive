import { resolveRouteDaemonOwner } from "../../src/dashboard/web/route-daemon-owner.js";

describe("resolveRouteDaemonOwner", () => {
	it("c-AC-2 maps the Hive Graph route to nectar", () => {
		expect(resolveRouteDaemonOwner("/hive-graph")).toBe("nectar");
	});

	it("c-AC-1 maps honeycomb-owned dashboard routes to honeycomb", () => {
		for (const route of ["/", "/memories", "/graph", "/settings", "/health"]) {
			expect(resolveRouteDaemonOwner(route)).toBe("honeycomb");
		}
	});
});
