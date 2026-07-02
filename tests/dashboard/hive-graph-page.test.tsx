// @vitest-environment jsdom
/**
 * PRD-015 — HiveGraphPage UI (route-mounted page behaviors).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ScopeContext, type ScopeContextValue } from "../../src/dashboard/web/scope-context.js";
import { HiveGraphPage } from "../../src/dashboard/web/pages/hive-graph.js";
import type { PageProps } from "../../src/dashboard/web/page-frame.js";
import {
	EMPTY_GRAPH,
	EMPTY_HIVE_GRAPH_STATUS,
	type HiveGraphBuildAck,
	type HiveGraphFileGraphWire,
	type HiveGraphSearchResultWire,
	type HiveGraphStatusResultWire,
	type WireClient,
} from "../../src/dashboard/web/wire.js";

function scopeWithProject(): ScopeContextValue {
	return {
		scope: { org: "local", workspace: "default", project: "proj-1" },
		setScope: () => {},
	};
}

function makeWire(overrides: Partial<WireClient> = {}): WireClient {
	const graphPayload: HiveGraphFileGraphWire = {
		graph: {
			built: true,
			nodes: [{ id: "n1", label: "src/a.ts", kind: "ts" }],
			edges: [],
		},
		files: {
			n1: {
				content_hash: "a".repeat(64),
				path: "src/a.ts",
				title: "a",
				description: "Login helper",
				concepts: [],
				describe_model: "m",
				described_at: "2026-07-02T00:00:00.000Z",
			},
		},
		derived: {},
		unreachable: false,
	};
	const statusPayload: HiveGraphStatusResultWire = {
		queueDepth: 2,
		describeStatus: { pending: 2, described: 5, failed: 0, "skipped-too-large": 0, "skipped-binary": 0, "skipped-deleted": 0 },
		costSpentUsd: 0.5,
		degraded: false,
		unreachable: false,
	};
	return {
		hiveGraphFileGraph: vi.fn(async () => graphPayload),
		hiveGraphStatus: vi.fn(async () => statusPayload),
		hiveGraphSearch: vi.fn(async (): Promise<HiveGraphSearchResultWire> => ({
			hits: [{ source: "nectar", id: "n1", path: "src/a.ts", title: "a", body: "Login helper", concepts: "", content_hash: "a".repeat(64) }],
			sources: ["nectar"],
			degraded: true,
			unreachable: false,
		})),
		hiveGraphBuild: vi.fn(async (): Promise<HiveGraphBuildAck> => ({ state: "accepted", message: "Build triggered" })),
		...overrides,
	} as unknown as WireClient;
}

function renderPage(wire: WireClient, scope: ScopeContextValue = scopeWithProject()): void {
	const props: PageProps = { wire, daemonUp: true, assetBase: "assets" };
	render(
		<ScopeContext.Provider value={scope}>
			<HiveGraphPage {...props} />
		</ScopeContext.Provider>,
	);
}

describe("HiveGraphPage", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("015-AC-1 a-AC-1 renders Hive Graph page frame with project selected", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByText("Hive Graph")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-status-widgets")).toBeTruthy();
	});

	it("015-AC-4 c-AC-4 disables search without a project (needs-selection)", async () => {
		renderPage(makeWire(), { scope: { org: "local", workspace: "default" }, setScope: () => {} });
		expect(screen.getByTestId("needs-project-selection")).toBeTruthy();
	});

	it("015-AC-4 c-AC-2 renders search hits and degraded footer", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByTestId("hive-graph-search-input")).toBeTruthy());
		fireEvent.change(screen.getByTestId("hive-graph-search-input"), { target: { value: "login" } });
		fireEvent.click(screen.getByTestId("hive-graph-search-submit"));
		await waitFor(() => expect(screen.getByTestId("hive-graph-search-degraded")).toBeTruthy());
		expect(screen.getByText("Login helper")).toBeTruthy();
	});

	it("015-AC-5 c-AC-5 maps status widgets from hiveGraphStatus", async () => {
		renderPage(makeWire());
		await waitFor(() => expect(screen.getByTestId("hive-graph-status-widgets")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-status-widgets").textContent).toContain("queue 2");
		expect(screen.getByTestId("hive-graph-status-widgets").textContent).toContain("described 5");
	});

	it("015-AC-6 b-AC-10 shows unavailable states when nectar is down", async () => {
		const wire = makeWire({
			hiveGraphFileGraph: vi.fn(async () => ({ graph: EMPTY_GRAPH, files: {}, derived: {}, unreachable: true })),
			hiveGraphStatus: vi.fn(async () => ({ ...EMPTY_HIVE_GRAPH_STATUS, unreachable: true })),
			hiveGraphSearch: vi.fn(async () => ({ hits: [], sources: [], degraded: true, unreachable: true })),
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("hive-graph-empty-state")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-empty-state").textContent).toContain("unreachable");
		fireEvent.change(screen.getByTestId("hive-graph-search-input"), { target: { value: "x" } });
		fireEvent.click(screen.getByTestId("hive-graph-search-submit"));
		await waitFor(() => expect(screen.getByTestId("hive-graph-search-unavailable")).toBeTruthy());
		expect(screen.getByTestId("hive-graph-status-unavailable")).toBeTruthy();
	});
});
