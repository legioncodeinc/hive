// @vitest-environment jsdom
/**
 * PRD-003c (m-AC-1 / m-AC-2) — the path-based router replaces the retired hash router.
 * `routeFromPath` mirrors the old `routeFromHash`'s pure-function contract; `usePathRoute` reads
 * `location.pathname`, re-renders on `popstate` (back/forward), and `navigate` pushes real History
 * entries rather than assigning `location.hash`.
 */

import { act, cleanup, renderHook } from "@testing-library/react";

import { routeFromPath, usePathRoute } from "../../src/dashboard/web/router.js";

describe("routeFromPath", () => {
	it("m-AC-1 normalizes an empty path to the default `/`", () => {
		expect(routeFromPath("")).toBe("/");
	});

	it("m-AC-1 returns a real path unchanged", () => {
		expect(routeFromPath("/graph")).toBe("/graph");
	});
});

describe("usePathRoute", () => {
	afterEach(() => {
		cleanup();
		window.history.replaceState(null, "", "/");
	});

	it("m-AC-1 reads the initial route from `location.pathname`, not `location.hash`", () => {
		window.history.replaceState(null, "", "/memories");
		const { result } = renderHook(() => usePathRoute());
		expect(result.current.route).toBe("/memories");
	});

	it("m-AC-2 `navigate` pushes a real History entry (a path, not a fragment)", () => {
		window.history.replaceState(null, "", "/");
		const { result } = renderHook(() => usePathRoute());

		act(() => {
			result.current.navigate("/graph");
		});

		expect(result.current.route).toBe("/graph");
		expect(window.location.pathname).toBe("/graph");
		expect(window.location.hash).toBe("");
	});

	it("m-AC-2 resolves the same screen on browser back/forward (real History entries + `popstate`)", () => {
		window.history.replaceState(null, "", "/");
		const { result } = renderHook(() => usePathRoute());

		act(() => {
			result.current.navigate("/settings");
		});
		expect(result.current.route).toBe("/settings");

		// Simulate the browser popping back to the PREVIOUS History entry: the entry itself changes
		// `location.pathname` (as a real back navigation would), then the browser fires `popstate` —
		// the hook's ONLY re-sync trigger besides its own `navigate`.
		act(() => {
			window.history.replaceState(null, "", "/");
			window.dispatchEvent(new PopStateEvent("popstate"));
		});

		expect(result.current.route).toBe("/");
	});
});
