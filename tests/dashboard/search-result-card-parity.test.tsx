// @vitest-environment jsdom
/**
 * ISS-006 — search results are the SAME interactive memory cards as the browse list.
 *
 * The /memories page used to render two result types on one surface: the pre-search list as
 * clickable rows (→ detail → edit/forget) and search results as inert text+score MemoryCards.
 * The primary acceptance criterion: a memory found by search renders as the SAME interactive
 * card with the same affordances — clickable (same detail view), edit (same edit flow), forget
 * (same forget flow + the hit leaves the rendered results) — keeping the engine score badge
 * (#24 `formatScore` precision). Hits WITHOUT an actionable memory id (session digests) keep
 * the legacy presentation.
 *
 * Coverage:
 *   1. `memoryIdFromHit` vintage matrix — explicit `memoryId` field, `"memories:<id>"` ref
 *      parse, today's bare `source`+`id`, sessions → null, garbage → null.
 *   2. The render matrix on the mounted page — memory hit → interactive row (click wired,
 *      edit+forget reachable, score badge); session hit → legacy inert card.
 *   3. An OLD-daemon payload (no `memoryId`/`ref`, just `source`+`id`) through the REAL wire
 *      client still renders interactively.
 *   4. Forget-from-search removes the hit from the rendered results and fires the SAME
 *      `wire.forgetMemory` call (same reason) as the list-originated forget.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { MemoriesPage } from "../../src/dashboard/web/pages/memories.js";
import type { PageProps } from "../../src/dashboard/web/page-frame.js";
import { ScopeContext } from "../../src/dashboard/web/scope-context.js";
import { clearSwrCache } from "../../src/dashboard/web/use-swr.js";
import {
	createWireClient,
	memoryIdFromHit,
	type MemoryRecordWire,
	type RecalledMemory,
	type WireClient,
} from "../../src/dashboard/web/wire.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A full persisted record for the detail re-read (`GET /api/memories/:id`). */
function record(id: string): MemoryRecordWire {
	return {
		id,
		type: "fact",
		content: "we deploy via just release",
		confidence: 0.9,
		agentId: "agent-1",
		createdAt: "2026-07-01T00:00:00Z",
		updatedAt: "2026-07-01T00:00:00Z",
		visibility: "team",
		sourceType: "manual",
		sourceId: "",
		version: 1,
		hasEmbedding: true,
	};
}

/** A memories-source hit that RESOLVED an actionable id (the new interactive path). */
const MEM_HIT: RecalledMemory = {
	memoryKey: "mem_1",
	snippet: "we deploy via just release",
	source: "memories",
	score: 0.0163,
	scope: "team",
	verified: true,
	kind: "memory",
	secondary: false,
	memoryId: "mem_1",
	type: "fact",
};

/** A session digest hit — NO memory identity — keeps the legacy inert presentation. */
const SESSION_HIT: RecalledMemory = {
	memoryKey: "hit-2",
	snippet: "a humanized session digest line",
	source: "sessions",
	score: 0.0009,
	scope: "session",
	verified: false,
	kind: "session",
	secondary: true,
	memoryId: null,
	type: "",
};

/** A stub wire covering every read/write the Memories page touches. */
function stubWire(overrides: Partial<Record<string, unknown>> = {}): WireClient {
	return {
		listMemories: vi.fn(async () => []),
		recall: vi.fn(async () => ({ memories: [MEM_HIT, SESSION_HIT], degraded: false })),
		getMemory: vi.fn(async (id: string) => record(id)),
		modifyMemory: vi.fn(async () => ({ id: "mem_1", action: "modify", audited: true })),
		forgetMemory: vi.fn(async () => ({ id: "mem_1", action: "forget", audited: true })),
		addMemory: vi.fn(async () => null),
		compact: vi.fn(async () => null),
		pollinate: vi.fn(async () => ({ triggered: false, status: "skipped" })),
		logs: vi.fn(async () => []),
		...overrides,
	} as unknown as WireClient;
}

/** Mount the page inside a project-selected scope (49e — no project ⇒ needs-selection state). */
function renderPage(wire: WireClient): void {
	const props: PageProps = { wire, daemonUp: true, assetBase: "assets" };
	render(
		<ScopeContext.Provider value={{ scope: { org: "local", workspace: "default", project: "proj-1" }, setScope: () => {} }}>
			<MemoriesPage {...props} />
		</ScopeContext.Provider>,
	);
}

/** Type a query + click Search, then wait for the results container. */
async function runSearch(query = "deploy"): Promise<void> {
	fireEvent.change(screen.getByPlaceholderText(/search memories/), { target: { value: query } });
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	await screen.findByTestId("search-results");
}

beforeEach(() => {
	clearSwrCache();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. memoryIdFromHit — the daemon-vintage matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("memoryIdFromHit (ISS-006: actionable identity across daemon vintages)", () => {
	it("prefers the explicit additive memoryId field (the new honeycomb contract)", () => {
		expect(memoryIdFromHit({ memoryId: "mem_explicit", ref: "memories:mem_ref", source: "sessions", id: "other" })).toBe(
			"mem_explicit",
		);
	});

	it("falls back to parsing the 'memories:<id>' ref prefix (old daemons)", () => {
		expect(memoryIdFromHit({ ref: "memories:mem_ref" })).toBe("mem_ref");
	});

	it("resolves today's bare source+id contract (source === 'memories')", () => {
		expect(memoryIdFromHit({ source: "memories", id: "mem_bare" })).toBe("mem_bare");
	});

	it("tolerates an accidental 'memories:' prefix on the bare id", () => {
		expect(memoryIdFromHit({ source: "memories", id: "memories:mem_pfx" })).toBe("mem_pfx");
	});

	it("returns null for a sessions ref (no actionable memory identity)", () => {
		expect(memoryIdFromHit({ ref: "sessions:2026-07-01" })).toBeNull();
	});

	it("returns null for a sessions-source hit", () => {
		expect(memoryIdFromHit({ source: "sessions", id: "captures/turn-9" })).toBeNull();
	});

	it("returns null for the 'memory' summaries arm (a path, not a memory id)", () => {
		expect(memoryIdFromHit({ source: "memory", id: "summaries/2026-07" })).toBeNull();
	});

	it("returns null on garbage / empty shapes, never a throw", () => {
		expect(memoryIdFromHit({})).toBeNull();
		expect(memoryIdFromHit({ memoryId: "", ref: "memories:", source: "memories", id: "" })).toBeNull();
		expect(memoryIdFromHit({ ref: "garbage-no-prefix" })).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The render matrix — interactive memory hit vs legacy session hit
// ─────────────────────────────────────────────────────────────────────────────

describe("search-result render matrix (ISS-006: one interactive result type)", () => {
	it("renders a memory hit as the SAME interactive row as the browse list, with the score badge", async () => {
		renderPage(stubWire());
		await runSearch();

		// The memory hit is the SAME clickable card the list renders (data-testid="memory-row").
		const rows = screen.getAllByTestId("memory-row");
		expect(rows).toHaveLength(1);
		expect(rows[0].getAttribute("data-memory-id")).toBe("mem_1");
		// The engine score badge is KEPT (#24 formatScore precision — never a flattened 0.00).
		expect(screen.getByTestId("row-score").textContent).toBe("0.0163");
	});

	it("wires the click handler to the SAME detail view (edit + forget affordances)", async () => {
		const wire = stubWire();
		renderPage(wire);
		await runSearch();

		fireEvent.click(screen.getByTestId("memory-row"));
		await screen.findByTestId("memory-detail");

		// Clicking re-read the FULL persisted record through the SAME wire read the list uses.
		expect(wire.getMemory).toHaveBeenCalledWith("mem_1");
		// The same edit + forget affordances the list-originated detail carries.
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
	});

	it("keeps the legacy inert presentation for a session hit (no memory identity)", async () => {
		renderPage(stubWire());
		await runSearch();

		// The session digest renders (its snippet is visible) but NOT as an interactive row.
		expect(screen.getByText("a humanized session digest line")).toBeTruthy();
		const rows = screen.getAllByTestId("memory-row");
		expect(rows.every((r) => r.getAttribute("data-memory-id") !== "hit-2")).toBe(true);
		expect(rows).toHaveLength(1);
	});

	it("renders an OLD-daemon payload (bare source+id, no memoryId/ref) interactively via the real wire", async () => {
		// The REAL createWireClient against a stubbed fetch — the defensive parse is exercised
		// end-to-end: an old daemon that sends only `{ source, id }` still yields an actionable id.
		const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const path = String(input);
			const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
			if (path.includes("/api/memories/recall")) {
				return ok({
					hits: [
						{ source: "memories", id: "mem_old", text: "we deploy via just release", score: 0.0163, kind: "memory", secondary: false },
						{ source: "sessions", id: "captures/turn-9", text: "{\"role\":\"user\"}", score: 0.0009, kind: "session", secondary: true },
					],
					sources: ["memories", "sessions"],
					degraded: false,
				});
			}
			if (path.includes("/api/memories?")) return ok({ memories: [] });
			// Every other read degrades honestly (the wire's non-ok → empty-state posture).
			return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
		});
		renderPage(createWireClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
		await runSearch();

		const row = await screen.findByTestId("memory-row");
		expect(row.getAttribute("data-memory-id")).toBe("mem_old");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Forget-from-search — same wire call, hit removed from the rendered results
// ─────────────────────────────────────────────────────────────────────────────

describe("forget from a search result (ISS-006: same flow, consistent views)", () => {
	it("fires the SAME wire.forgetMemory call as the list's forget and removes the hit", async () => {
		const wire = stubWire();
		renderPage(wire);
		await runSearch();

		// Open the SAME detail view the list opens, then run the SAME confirm-gated forget flow.
		fireEvent.click(screen.getByTestId("memory-row"));
		await screen.findByTestId("memory-detail");
		fireEvent.click(screen.getByRole("button", { name: "Forget" }));
		fireEvent.click(await screen.findByRole("button", { name: "Confirm forget" }));

		// The SAME wire call (same endpoint method, same dashboard reason) as a list-originated forget.
		await waitFor(() => expect(wire.forgetMemory).toHaveBeenCalledWith("mem_1", { reason: "forgotten via dashboard" }));

		// The detail closes and the search results re-render WITHOUT the forgotten memory…
		await waitFor(() => expect(screen.queryByTestId("memory-detail")).toBeNull());
		expect(screen.getByTestId("search-results")).toBeTruthy();
		expect(screen.queryByTestId("memory-row")).toBeNull();
		// …while the (id-less) session hit keeps rendering — only the forgotten memory left.
		expect(screen.getByText("a humanized session digest line")).toBeTruthy();
	});
});
