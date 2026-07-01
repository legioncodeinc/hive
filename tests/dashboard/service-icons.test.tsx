// @vitest-environment jsdom
/**
 * the-hive PRD-004b — the bee-status SVG set + the single shared state→icon mapping.
 */

import { cleanup, render } from "@testing-library/react";

import { SERVICE_STATE_COLOR, SERVICE_STATE_LABEL, ServiceStateIcon } from "../../src/dashboard/web/service-icons.js";
import { SERVICE_STATES } from "../../src/shared/service-status.js";

afterEach(() => cleanup());

describe("ServiceStateIcon (svg-AC-1..5)", () => {
	it.each(SERVICE_STATES)("svg-AC-1: renders a distinct SVG for state %s", (state) => {
		const { container } = render(<ServiceStateIcon state={state} />);
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("data-service-state")).toBe(state);
	});

	it("svg-AC-2: every state's markup differs in shape/motif, not only by inline color", () => {
		// Render each icon and collect its shape-defining markup (tag names + path/shape attrs),
		// stripped of any `style`/`color` attributes — proving the DIFFERENCE is structural.
		const shapes = SERVICE_STATES.map((state) => {
			const { container } = render(<ServiceStateIcon state={state} />);
			const svg = container.querySelector("svg") as SVGElement;
			const signature = Array.from(svg.querySelectorAll("*"))
				.map((el) => `${el.tagName}:${el.getAttribute("d") ?? el.getAttribute("cx") ?? el.getAttribute("rx") ?? ""}`)
				.join("|");
			cleanup();
			return signature;
		});
		const unique = new Set(shapes);
		expect(unique.size).toBe(SERVICE_STATES.length);
	});

	it("svg-AC-5: an unexpected value resolves to the fail-safe fallback icon, never a blank render", () => {
		const { container } = render(<ServiceStateIcon state="some-unexpected-value" />);
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("data-service-state")).toBe("unknown");
	});

	it("svg-AC-3: every icon uses currentColor so it stays legible against a dark-mode text color", () => {
		for (const state of SERVICE_STATES) {
			const { container } = render(<ServiceStateIcon state={state} />);
			const svg = container.querySelector("svg") as SVGElement;
			expect(svg.innerHTML).toContain("currentColor");
			cleanup();
		}
	});
});

describe("SERVICE_STATE_LABEL / SERVICE_STATE_COLOR (svg-AC-4 shared mapping)", () => {
	it("has an entry for every locked state", () => {
		for (const state of SERVICE_STATES) {
			expect(SERVICE_STATE_LABEL[state]).toBeTruthy();
			expect(SERVICE_STATE_COLOR[state]).toBeTruthy();
		}
	});
});
