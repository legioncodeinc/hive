/**
 * PRD-015b — projection → GraphWire client-side transform.
 */

import { capGraphForRender, MAX_RENDER_NODES } from "../../src/dashboard/web/wire.js";
import { fileKindFromPath, projectionToGraphWire, type PortableProjectionWire } from "../../src/dashboard/web/hive-graph-projection.js";

const SAMPLE: PortableProjectionWire = {
	version: 1,
	generated_at: "2026-07-02T00:00:00.000Z",
	generator: "test",
	project: { org_id: "o", workspace_id: "w", project_id: "p" },
	files: {
		n1: {
			content_hash: "a".repeat(64),
			path: "src/auth/login.ts",
			title: "login",
			description: "Handles login",
			concepts: [],
			describe_model: "m",
			described_at: "2026-07-02T00:00:00.000Z",
		},
		n2: {
			content_hash: "b".repeat(64),
			path: "src/auth/copy.ts",
			title: "copy",
			description: "Copied file",
			concepts: [],
			describe_model: "m",
			described_at: "2026-07-02T00:00:00.000Z",
		},
		n3: {
			content_hash: "c".repeat(64),
			path: "README.md",
			title: "readme",
			description: "Root readme",
			concepts: [],
			describe_model: "m",
			described_at: "2026-07-02T00:00:00.000Z",
		},
	},
	derived: {
		n2: { from_nectar: "n1", fork_content_hash: "b".repeat(64) },
	},
};

describe("015b projection transform", () => {
	it("015-AC-3 b-AC-1 maps files to GraphNode id/label/kind", () => {
		expect(fileKindFromPath("src/auth/login.ts")).toBe("ts");
		expect(fileKindFromPath("README.md")).toBe("md");
		const graph = projectionToGraphWire(SAMPLE);
		expect(graph.built).toBe(true);
		const n1 = graph.nodes.find((n) => n.id === "n1");
		expect(n1).toEqual({ id: "n1", label: "src/auth/login.ts", kind: "ts" });
	});

	it("015-AC-3 b-AC-2 maps derived entries to derived_from edges", () => {
		const graph = projectionToGraphWire(SAMPLE);
		expect(graph.edges).toEqual([{ from: "n2", to: "n1", kind: "derived_from" }]);
	});

	it("015-AC-3 b-AC-3 omits edges for root nectars", () => {
		const graph = projectionToGraphWire(SAMPLE);
		expect(graph.edges.some((e) => e.from === "n1" || e.from === "n3")).toBe(false);
	});

	it("015-AC-3 b-AC-7/b-AC-8 capGraphForRender bounds dense graphs client-side only", () => {
		const manyFiles: PortableProjectionWire["files"] = {};
		for (let i = 0; i < MAX_RENDER_NODES + 50; i++) {
			manyFiles[`n${i}`] = {
				content_hash: "a".repeat(64),
				path: `file-${i}.ts`,
				title: "",
				description: "",
				concepts: [],
				describe_model: "m",
				described_at: "2026-07-02T00:00:00.000Z",
			};
		}
		const huge = projectionToGraphWire({ ...SAMPLE, files: manyFiles, derived: {} });
		expect(huge.meta).toBeUndefined();
		const { graph: capped, capped: didCap } = capGraphForRender(huge, MAX_RENDER_NODES);
		expect(didCap).toBe(true);
		expect(capped.nodes.length).toBe(MAX_RENDER_NODES);
	});
});
