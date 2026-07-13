/**
 * ISS-006 (follow-up from honeycomb#307): the dashboard Add form previously POSTed without a
 * project header, so every added memory landed in the `__unsorted__` inbox — invisible to the
 * project view the user was looking at. `addMemory` now stamps the SELECTED project.
 */

import { createWireClient } from "../../src/dashboard/web/wire.js";

function captureFetch(): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
		return new Response(JSON.stringify({ ok: true, id: "mem_x", action: "inserted" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe("ISS-006 addMemory project stamping", () => {
	it("stamps x-honeycomb-project with the viewed project", async () => {
		const { fetchImpl, calls } = captureFetch();
		const wire = createWireClient({ fetchImpl });
		await wire.addMemory({ content: "a fact", projectId: "the-apiary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers["x-honeycomb-project"]).toBe("the-apiary");
	});

	it("sends NO project header when no project is selected (inbox semantics unchanged)", async () => {
		const { fetchImpl, calls } = captureFetch();
		const wire = createWireClient({ fetchImpl });
		await wire.addMemory({ content: "a fact" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers["x-honeycomb-project"]).toBeUndefined();
	});
});
