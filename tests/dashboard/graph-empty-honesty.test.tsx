// @vitest-environment jsdom
/**
 * ISS-002 — the Memory Graph page says WHY it is empty (SP-3 / SP-4).
 *
 * The honeycomb daemon now adds an ADDITIVE `reason` ("graph_off" | "no_entities_yet" |
 * "query_error") + optional progress counts to the `built:false` memory-graph response. These
 * tests cover the wire back-compat matrix (no reason → generic; each reason → its state;
 * garbage reason → generic — old daemons send none of it and must keep working), the
 * reason-branched empty states on the page, the `graph_off` inline enable affordance
 * (writes `graph.enabled=true` via the existing settings save path, then refetches), and
 * the `query_error` retry. All against a MOCKED wire (no live daemon).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ScopeContext, type ScopeContextValue } from "../../src/dashboard/web/scope-context.js";
import { GraphPage } from "../../src/dashboard/web/pages/graph.js";
import type { PageProps } from "../../src/dashboard/web/page-frame.js";
import { clearSwrCache } from "../../src/dashboard/web/use-swr.js";
import { GraphSchema, type GraphWire, type WireClient } from "../../src/dashboard/web/wire.js";

/** A scope with a project selected (the graph fetch is disabled without one). */
function scopeWithProject(): ScopeContextValue {
	return {
		scope: { org: "local", workspace: "default", project: "proj-1" },
		setScope: () => {},
	};
}

/** Build a mock wire around a `memoryGraph` responder + a `setSetting` acceptor. */
function mockWire(
	memoryGraph: () => Promise<GraphWire>,
	opts: { setSettingOk?: boolean } = {},
): { wire: WireClient; memoryGraph: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> } {
	const memoryGraphFn = vi.fn(memoryGraph);
	const setSetting = vi.fn(async () => opts.setSettingOk ?? true);
	const wire = { memoryGraph: memoryGraphFn, setSetting } as unknown as WireClient;
	return { wire, memoryGraph: memoryGraphFn, setSetting };
}

function renderPage(wire: WireClient): void {
	const props: PageProps = { wire, daemonUp: true, assetBase: "assets" };
	render(
		<ScopeContext.Provider value={scopeWithProject()}>
			<GraphPage {...props} />
		</ScopeContext.Provider>,
	);
}

/** An empty `built:false` body with optional extras merged in. */
function emptyBody(extra: Record<string, unknown> = {}): unknown {
	return { built: false, nodes: [], edges: [], ...extra };
}

beforeEach(() => clearSwrCache());
afterEach(() => cleanup());

// ── The wire back-compat matrix (GraphSchema) ─────────────────────────────────

describe("GraphSchema reason back-compat matrix", () => {
	it("no reason field (old daemon) → parses with reason undefined", () => {
		const parsed = GraphSchema.parse(emptyBody());
		expect(parsed.built).toBe(false);
		expect(parsed.reason).toBeUndefined();
		expect(parsed.memoriesScanned).toBeUndefined();
		expect(parsed.entitiesFound).toBeUndefined();
	});

	it.each(["graph_off", "no_entities_yet", "query_error"] as const)("reason %s → preserved on the wire", (reason) => {
		const parsed = GraphSchema.parse(emptyBody({ reason }));
		expect(parsed.reason).toBe(reason);
	});

	it("garbage reason → catches to undefined (generic state), never a throw", () => {
		const parsed = GraphSchema.parse(emptyBody({ reason: "banana" }));
		expect(parsed.reason).toBeUndefined();
	});

	it("counts preserved when numeric, catch to undefined when garbage", () => {
		const good = GraphSchema.parse(emptyBody({ reason: "no_entities_yet", memoriesScanned: 12, entitiesFound: 0 }));
		expect(good.memoriesScanned).toBe(12);
		expect(good.entitiesFound).toBe(0);
		const bad = GraphSchema.parse(emptyBody({ memoriesScanned: "lots", entitiesFound: null }));
		expect(bad.memoriesScanned).toBeUndefined();
		expect(bad.entitiesFound).toBeUndefined();
	});
});

// ── The reason-branched empty states on the page ──────────────────────────────

describe("GraphPage empty-state honesty (ISS-002)", () => {
	it("no reason (old daemon) → today's generic empty state, unchanged", async () => {
		const { wire } = mockWire(async () => GraphSchema.parse(emptyBody()));
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-empty-state")).toBeTruthy());
		expect(screen.getByTestId("graph-empty-state").getAttribute("data-reason")).toBe("unknown");
		expect(screen.getByTestId("graph-empty-state").textContent).toContain("No memory graph yet for this workspace.");
		expect(screen.queryByTestId("graph-enable-button")).toBeNull();
		expect(screen.queryByTestId("graph-retry-button")).toBeNull();
	});

	it("garbage reason → the schema catches it and the page renders the generic state", async () => {
		const { wire } = mockWire(async () => GraphSchema.parse(emptyBody({ reason: "banana" })));
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-empty-state")).toBeTruthy());
		expect(screen.getByTestId("graph-empty-state").getAttribute("data-reason")).toBe("unknown");
		expect(screen.getByTestId("graph-empty-state").textContent).toContain("No memory graph yet for this workspace.");
	});

	it("reason graph_off → 'Graph persistence is off' + the inline enable affordance", async () => {
		const { wire } = mockWire(async () => GraphSchema.parse(emptyBody({ reason: "graph_off" })));
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-empty-state").getAttribute("data-reason")).toBe("graph_off"));
		expect(screen.getByTestId("graph-empty-state").textContent).toContain("Graph persistence is off");
		expect(screen.getByTestId("graph-enable-button")).toBeTruthy();
	});

	it("reason no_entities_yet → 'No entities extracted yet' + the honest scanned count when present", async () => {
		const { wire } = mockWire(async () => GraphSchema.parse(emptyBody({ reason: "no_entities_yet", memoriesScanned: 12, entitiesFound: 0 })));
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-empty-state").getAttribute("data-reason")).toBe("no_entities_yet"));
		expect(screen.getByTestId("graph-empty-state").textContent).toContain("No entities extracted yet");
		expect(screen.getByTestId("graph-empty-counts").textContent).toBe("12 memories scanned");
	});

	it("reason no_entities_yet WITHOUT counts → no counts line (never a fabricated number)", async () => {
		const { wire } = mockWire(async () => GraphSchema.parse(emptyBody({ reason: "no_entities_yet" })));
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-empty-state").getAttribute("data-reason")).toBe("no_entities_yet"));
		expect(screen.queryByTestId("graph-empty-counts")).toBeNull();
	});

	it("reason query_error → the honest error state with a retry that refetches", async () => {
		const { wire, memoryGraph } = mockWire(async () => GraphSchema.parse(emptyBody({ reason: "query_error" })));
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-empty-state").getAttribute("data-reason")).toBe("query_error"));
		expect(screen.getByTestId("graph-empty-state").textContent).toContain("Could not read the memory graph");
		const callsBefore = memoryGraph.mock.calls.length;
		fireEvent.click(screen.getByTestId("graph-retry-button"));
		await waitFor(() => expect(memoryGraph.mock.calls.length).toBeGreaterThan(callsBefore));
	});
});

// ── The graph_off enable affordance (settings write + refetch) ────────────────

describe("GraphPage graph_off enable affordance", () => {
	it("clicking Enable writes graph.enabled=true via the settings save path, refetches, and renders the graph", async () => {
		// The daemon reports graph_off until the setting write lands, then serves a built graph —
		// the refetch after the write must flip the page to the canvas.
		let enabled = false;
		const { wire, memoryGraph, setSetting } = mockWire(async () =>
			enabled
				? GraphSchema.parse({ built: true, nodes: [{ id: "m1", label: "memory one", kind: "memory" }], edges: [] })
				: GraphSchema.parse(emptyBody({ reason: "graph_off" })),
		);
		(wire.setSetting as ReturnType<typeof vi.fn>).mockImplementation(async (key: string, value: unknown) => {
			if (key === "graph.enabled" && value === true) enabled = true;
			return true;
		});
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-enable-button")).toBeTruthy());
		const callsBefore = memoryGraph.mock.calls.length;
		fireEvent.click(screen.getByTestId("graph-enable-button"));
		await waitFor(() => expect(setSetting).toHaveBeenCalledWith("graph.enabled", true));
		await waitFor(() => expect(memoryGraph.mock.calls.length).toBeGreaterThan(callsBefore));
		await waitFor(() => expect(screen.getByTestId("graph-canvas")).toBeTruthy());
		expect(screen.queryByTestId("graph-empty-state")).toBeNull();
	});

	it("a rejected settings write renders the honest failure note, never a fake success", async () => {
		const { wire, memoryGraph, setSetting } = mockWire(async () => GraphSchema.parse(emptyBody({ reason: "graph_off" })), { setSettingOk: false });
		renderPage(wire);
		await waitFor(() => expect(screen.getByTestId("graph-enable-button")).toBeTruthy());
		const callsBefore = memoryGraph.mock.calls.length;
		fireEvent.click(screen.getByTestId("graph-enable-button"));
		await waitFor(() => expect(setSetting).toHaveBeenCalledWith("graph.enabled", true));
		await waitFor(() => expect(screen.getByTestId("graph-enable-failed")).toBeTruthy());
		// A failed write must NOT trigger the refetch (nothing changed daemon-side).
		expect(memoryGraph.mock.calls.length).toBe(callsBefore);
	});
});
