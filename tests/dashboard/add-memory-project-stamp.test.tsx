// @vitest-environment jsdom
/**
 * ISS-006 (follow-up from honeycomb#307, user decision 2026-07-12): the Add form's destination
 * is an EXPLICIT project selector — defaulting to the viewed project, retargetable, with Inbox
 * as a first-class option — never an implicit side effect of the view filter (SP-4). The wire
 * layer stamps `x-honeycomb-project` only when a destination project was chosen.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { AddForm } from "../../src/dashboard/web/pages/memories.js";
import { createWireClient } from "../../src/dashboard/web/wire.js";

afterEach(() => {
	cleanup();
});

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

const PROJECTS = [
	{ projectId: "the-apiary", name: "the-apiary" },
	{ projectId: "inter-city-yacht-club", name: "inter-city-yacht-club" },
	{ projectId: "__unsorted__", name: "" },
] as const;

describe("ISS-006 AddForm explicit destination selector (SP-4: never an implicit view side effect)", () => {
	it("defaults the selector to the VIEWED project and submits it explicitly", async () => {
		const seen: Array<string | undefined> = [];
		render(
			<AddForm
				onAdd={async (_c, _t, projectId) => {
					seen.push(projectId);
					return "stored · mem_1 → the-apiary";
				}}
				projects={PROJECTS}
				viewedProject="the-apiary"
			/>,
		);
		const select = screen.getByTestId("add-project") as HTMLSelectElement;
		expect(select.value).toBe("the-apiary");
		// The inbox sentinel is folded into the Inbox option, never listed twice.
		expect(screen.queryByText("__unsorted__")).toBeNull();
		fireEvent.change(screen.getByLabelText("new content"), { target: { value: "a fact" } });
		fireEvent.click(screen.getByText("Add memory"));
		await waitFor(() => expect(seen).toEqual(["the-apiary"]));
		expect(screen.getByTestId("add-note").textContent).toContain("→ the-apiary");
	});

	it("the user can retarget to the Inbox — an undefined destination, regardless of the view", async () => {
		const seen: Array<string | undefined> = [];
		render(
			<AddForm
				onAdd={async (_c, _t, projectId) => {
					seen.push(projectId);
					return "stored · mem_2 → inbox";
				}}
				projects={PROJECTS}
				viewedProject="the-apiary"
			/>,
		);
		fireEvent.change(screen.getByTestId("add-project"), { target: { value: "" } });
		fireEvent.change(screen.getByLabelText("new content"), { target: { value: "another fact" } });
		fireEvent.click(screen.getByText("Add memory"));
		await waitFor(() => expect(seen).toEqual([undefined]));
	});

	it("no viewed project → the selector defaults to Inbox", () => {
		render(<AddForm onAdd={async () => "ok"} projects={PROJECTS} viewedProject={undefined} />);
		expect((screen.getByTestId("add-project") as HTMLSelectElement).value).toBe("");
	});
});
