// @vitest-environment jsdom
/**
 * ISS-011 — the NetHero partial-net matrix:
 *   - `status:"ok"` + `computed:true`        → the number renders, NO "partial" badge;
 *   - `status:"partial"` + `computed:true` +
 *     `partial:true`                          → the number renders + an amber "partial" badge +
 *                                               an "excludes: …" caption listing `missingInputs`;
 *   - `computed:false`                        → the DASH renders (e-AC-6 net-not-fabricated, unchanged).
 */

import { cleanup, render, screen } from "@testing-library/react";

import type { RoiNetSection } from "../../src/dashboard/contracts.js";
import { DASH, NetHero, formatCents } from "../../src/dashboard/web/pages/roi.js";

function net(overrides: Partial<RoiNetSection>): RoiNetSection {
	return {
		status: "ok",
		computed: true,
		netCents: 12034,
		modeled: true,
		costBasis: "measured",
		partial: false,
		missingInputs: [],
		...overrides,
	};
}

function renderHero(section: RoiNetSection): void {
	render(<NetHero net={section} onRetry={() => {}} retrying={false} />);
}

afterEach(() => {
	cleanup();
});

describe("NetHero partial-net matrix (ISS-011)", () => {
	it("ok + computed → the number, no partial badge", () => {
		renderHero(net({ status: "ok", computed: true, netCents: 12034 }));
		const figure = screen.getByTestId("net-figure");
		expect(figure.getAttribute("data-computed")).toBe("true");
		expect(figure.textContent).toBe(formatCents(12034, true));
		expect(screen.queryByTestId("net-partial-badge")).toBeNull();
		expect(screen.queryByTestId("net-partial-excludes")).toBeNull();
	});

	it("partial + computed → the number + the amber partial badge + the excludes caption", () => {
		renderHero(net({ status: "partial", computed: true, netCents: 5000, partial: true, missingInputs: ["infra", "pollination"] }));
		const figure = screen.getByTestId("net-figure");
		expect(figure.getAttribute("data-computed")).toBe("true");
		expect(figure.textContent).toBe(formatCents(5000, true));
		expect(figure.textContent).not.toBe(DASH);
		// The amber disclosure: the "partial" badge…
		expect(screen.getByTestId("net-partial-badge").textContent).toContain("partial");
		// …and the excludes caption, listing the missing inputs verbatim.
		expect(screen.getByTestId("net-partial-excludes").textContent).toBe("excludes: infra, pollination");
	});

	it("partial with an EMPTY missingInputs list shows the badge but no dangling excludes caption", () => {
		renderHero(net({ status: "partial", computed: true, netCents: 5000, partial: true, missingInputs: [] }));
		expect(screen.getByTestId("net-partial-badge")).toBeTruthy();
		expect(screen.queryByTestId("net-partial-excludes")).toBeNull();
	});

	it("computed:false → the DASH, never a fabricated number (e-AC-6 unchanged)", () => {
		renderHero(net({ status: "absent", computed: false, netCents: 0 }));
		const figure = screen.getByTestId("net-figure");
		expect(figure.getAttribute("data-computed")).toBe("false");
		expect(figure.textContent).toBe(DASH);
		expect(screen.queryByTestId("net-partial-badge")).toBeNull();
		expect(screen.getByText("net not computed yet")).toBeTruthy();
	});

	it("computed:false stays a DASH even when a malformed payload claims partial:true", () => {
		// Defensive: `partial` only ever ADDS disclosure to a computed net — it can never resurrect
		// an uncomputed one into showing a number.
		renderHero(net({ status: "partial", computed: false, netCents: 999, partial: true, missingInputs: ["infra"] }));
		expect(screen.getByTestId("net-figure").textContent).toBe(DASH);
		expect(screen.queryByTestId("net-partial-badge")).toBeNull();
	});

	it("unreachable keeps the scoped Retry affordance (unchanged)", () => {
		renderHero(net({ status: "unreachable", computed: false }));
		expect(screen.getByTestId("net-retry")).toBeTruthy();
		expect(screen.getByTestId("net-figure").textContent).toBe(DASH);
	});
});
