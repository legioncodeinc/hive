/**
 * PRD-015 — hive-graph wire methods (mocked fetch).
 */

import {
	ENDPOINTS,
	EMPTY_GRAPH,
	EMPTY_HIVE_GRAPH_STATUS,
	EMPTY_NECTAR_PROJECTS,
	createWireClient,
	type FetchLike,
} from "../../src/dashboard/web/wire.js";

function requestUrl(input: Parameters<FetchLike>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("015 hive-graph wire methods", () => {
	it("015-AC-2 a-AC-5 hiveGraphSearch posts to /api/hive-graph/search with project query", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
			const url = requestUrl(input);
			expect(url).toBe("/api/hive-graph/search?project=proj-1");
			expect(init?.method).toBe("POST");
			return jsonResponse({ hits: [{ source: "nectar", id: "n1", path: "a.ts", title: "a", body: "desc", concepts: "", content_hash: "c".repeat(64) }], sources: ["nectar"], degraded: false });
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		const res = await wire.hiveGraphSearch("login", "proj-1");
		expect(res.hits[0]?.path).toBe("a.ts");
		expect(res.degraded).toBe(false);
		expect(res.unreachable).toBe(false);
	});

	it("015-AC-5 c-AC-5 hiveGraphStatus reads /api/hive-graph/status", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
			expect(requestUrl(input)).toBe("/api/hive-graph/status?project=proj-1");
			return jsonResponse({
				queueDepth: 3,
				describeStatus: { pending: 3, described: 10, failed: 1, "skipped-too-large": 0, "skipped-binary": 0, "skipped-deleted": 0 },
				costSpentUsd: 1.25,
				degraded: false,
			});
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		const status = await wire.hiveGraphStatus("proj-1");
		expect(status.queueDepth).toBe(3);
		expect(status.describeStatus.described).toBe(10);
		expect(status.costSpentUsd).toBe(1.25);
		expect(status.unreachable).toBe(false);
	});

	it("015-AC-3 b-AC-1 hiveGraphFileGraph fetches projection and transforms to GraphWire", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
			expect(requestUrl(input)).toBe("/api/hive-graph/projection?project=proj-1");
			return jsonResponse({
				version: 1,
				generated_at: "2026-07-02T00:00:00.000Z",
				generator: "test",
				project: { org_id: "o", workspace_id: "w", project_id: "proj-1" },
				files: {
					n1: {
						content_hash: "a".repeat(64),
						path: "src/a.ts",
						title: "a",
						description: "A file",
						concepts: [],
						describe_model: "m",
						described_at: "2026-07-02T00:00:00.000Z",
					},
				},
				derived: {},
			});
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		const res = await wire.hiveGraphFileGraph("proj-1");
		expect(res.unreachable).toBe(false);
		expect(res.graph.built).toBe(true);
		expect(res.graph.nodes[0]).toMatchObject({ id: "n1", label: "src/a.ts", kind: "ts" });
		expect(res.files.n1?.description).toBe("A file");
	});

	it("015-AC-6 c-AC-7 degrades to unreachable on nectar failure", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
			const url = requestUrl(input);
			if (url.startsWith(ENDPOINTS.hiveGraphProjection)) return jsonResponse({ error: "unreachable" }, 502);
			if (url.startsWith(ENDPOINTS.hiveGraphStatus)) return jsonResponse({ error: "unreachable" }, 502);
			if (url.startsWith(ENDPOINTS.hiveGraphSearch)) return jsonResponse({ error: "unreachable" }, 502);
			return jsonResponse({}, 404);
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		await expect(wire.hiveGraphFileGraph("p")).resolves.toEqual({ graph: EMPTY_GRAPH, files: {}, derived: {}, unreachable: true });
		await expect(wire.hiveGraphStatus("p")).resolves.toMatchObject({ ...EMPTY_HIVE_GRAPH_STATUS, unreachable: true });
		await expect(wire.hiveGraphSearch("q", "p")).resolves.toMatchObject({ hits: [], degraded: true, unreachable: true });
	});

	it("015-AC-5 c-AC-8 hiveGraphBuild surfaces unavailable, already_running, and accepted", async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ error: "build_unavailable", reason: "not wired" }, 501))
			.mockResolvedValueOnce(jsonResponse({ status: "already_running", message: "busy" }, 409))
			.mockResolvedValueOnce(jsonResponse({ describedCount: 1 }, 200)) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		await expect(wire.hiveGraphBuild()).resolves.toEqual({ state: "unavailable", message: "not wired" });
		await expect(wire.hiveGraphBuild()).resolves.toEqual({ state: "already_running", message: "busy" });
		await expect(wire.hiveGraphBuild()).resolves.toEqual({ state: "accepted", message: "Build triggered" });
	});
});

describe("019c nectar projects wire methods", () => {
	it("c-AC-3 nectarProjects reads GET /api/hive-graph/projects", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
			expect(requestUrl(input)).toBe("/api/hive-graph/projects");
			return jsonResponse({
				globalBrooding: "on",
				projects: [
					{
						projectId: "p1",
						name: "my-repo",
						path: "/home/user/my-repo",
						brooding: "active",
						watcher: "running",
						counts: { described: 3, pending: 1 },
					},
				],
			});
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		const res = await wire.nectarProjects();
		expect(res.unreachable).toBe(false);
		expect(res.projects[0]?.brooding).toBe("active");
		expect(res.projects[0]?.path).toBe("/home/user/my-repo");
	});

	it("c-AC-4 setNectarBrooding posts POST /api/hive-graph/projects/brooding", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
			expect(requestUrl(input)).toBe("/api/hive-graph/projects/brooding");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({ projectId: "p1", brooding: "off" });
			return jsonResponse({
				globalBrooding: "on",
				projects: [{ projectId: "p1", name: "my-repo", path: "/repo", brooding: "paused", watcher: "stopped", counts: { described: 3, pending: 0 } }],
			});
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		const ack = await wire.setNectarBrooding({ projectId: "p1", brooding: "off" });
		expect(ack.unreachable).toBe(false);
		expect(ack.projects[0]?.brooding).toBe("paused");
	});

	it("c-AC-6 nectarProjects degrades to unreachable on nectar failure", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "unreachable" }, 502)) as unknown as FetchLike;
		const wire = createWireClient({ fetchImpl });
		await expect(wire.nectarProjects()).resolves.toEqual({ ...EMPTY_NECTAR_PROJECTS, unreachable: true });
		await expect(wire.setNectarBrooding({ global: "paused" })).resolves.toEqual({ ...EMPTY_NECTAR_PROJECTS, unreachable: true });
	});
});
