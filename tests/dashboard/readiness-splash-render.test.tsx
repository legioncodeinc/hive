// @vitest-environment jsdom
/**
 * PRD-002b: ReadinessSplash render behavior (rs-AC-2, rs-AC-3, rs-AC-4, rs-AC-5, rs-AC-6, rs-AC-7,
 * rs-AC-9). `readiness-splash.test.ts` covers the pure helper functions under the project's default
 * `node` vitest environment; this file closes prd-002c's test-plan gap for the actual rendered
 * behavior (poll gating, per-daemon grid, the sticky transition into SetupGate) using jsdom +
 * `@testing-library/react`, opted in per-file via the `@vitest-environment` pragma above so the
 * rest of the suite keeps its faster `node` default.
 *
 * A short `pollMs` override plus real timers (no fake-timer/act interleaving) keeps each test fast
 * and simple. Global `fetch` is stubbed once per test: `/api/fleet-status` responses are drawn from
 * a queue the test controls; every other endpoint (`/api/daemon-bases`, `/setup/state`, ...) returns
 * a non-ok response, which `wire.ts`/`SetupGate` already fail-soft on (no crash, no token involved).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { ReadinessSplash } from "../../src/dashboard/web/readiness-splash.js";

interface FetchCall {
	readonly url: string;
}

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("ReadinessSplash render behavior", () => {
	let calls: FetchCall[];
	let fleetStatusQueue: unknown[];

	beforeEach(() => {
		calls = [];
		fleetStatusQueue = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				calls.push({ url });
				if (url.includes("/api/fleet-status")) {
					const next = fleetStatusQueue.length > 0 ? fleetStatusQueue.shift() : { supervisor: "unreachable", daemons: [] };
					return jsonResponse(next);
				}
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	function fleetStatusCallCount(): number {
		return calls.filter((call) => call.url.includes("/api/fleet-status")).length;
	}

	it("rs-AC-2 shows the splash by default before the first poll resolves", () => {
		render(<ReadinessSplash assetBase="assets" pollMs={10} />);
		expect(screen.getByTestId("readiness-splash")).toBeTruthy();
		expect(screen.queryByTestId("guided-setup")).toBeNull();
	});

	it("rs-AC-4 defaults to a poll interval between 1000ms and 2000ms", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		render(<ReadinessSplash assetBase="assets" />);
		const delays = setIntervalSpy.mock.calls.map((call) => call[1]).filter((delay): delay is number => typeof delay === "number");
		expect(delays.some((delay) => delay >= 1000 && delay <= 2000)).toBe(true);
		setIntervalSpy.mockRestore();
	});

	it("rs-AC-3 does not mount SetupGate (or fetch /setup/state) while the fleet is not ready", async () => {
		fleetStatusQueue.push(
			{ supervisor: "reachable", health: "degraded", asOf: "2026-07-01T12:00:00.000Z", daemons: [{ name: "honeycomb", health: "ok", escalation: null }] },
			{ supervisor: "reachable", health: "degraded", asOf: "2026-07-01T12:00:00.000Z", daemons: [{ name: "honeycomb", health: "ok", escalation: null }] },
		);
		render(<ReadinessSplash assetBase="assets" pollMs={10} />);

		await waitFor(() => expect(fleetStatusCallCount()).toBeGreaterThanOrEqual(2));

		expect(screen.queryByTestId("guided-setup")).toBeNull();
		expect(calls.some((call) => call.url.includes("/setup/state"))).toBe(false);
	});

	it("rs-AC-6 shows the distinct hivedoctor-unreachable indicator, not an empty grid", async () => {
		fleetStatusQueue.push({ supervisor: "unreachable", daemons: [] });
		render(<ReadinessSplash assetBase="assets" pollMs={10} />);

		await waitFor(() => expect(screen.getByTestId("readiness-hivedoctor-unreachable")).toBeTruthy());
		expect(screen.queryByTestId("readiness-daemon-grid")).toBeNull();
	});

	it("rs-AC-5 renders one row per daemon with the correctly mapped display state", async () => {
		fleetStatusQueue.push({
			supervisor: "reachable",
			health: "degraded",
			asOf: "2026-07-01T12:00:00.000Z",
			daemons: [
				{ name: "honeycomb", health: "ok", escalation: null },
				{ name: "hivenectar", health: "degraded", escalation: null },
				{ name: "thehive", health: "unreachable", escalation: null },
				{ name: "future-peer", health: "unknown", escalation: null },
			],
		});
		render(<ReadinessSplash assetBase="assets" pollMs={10} />);

		await waitFor(() => expect(screen.getByTestId("readiness-daemon-grid")).toBeTruthy());
		expect(screen.getByTestId("readiness-daemon-honeycomb").textContent).toContain("up");
		expect(screen.getByTestId("readiness-daemon-hivenectar").textContent).toContain("degraded");
		expect(screen.getByTestId("readiness-daemon-thehive").textContent).toContain("unreachable");
		expect(screen.getByTestId("readiness-daemon-future-peer").textContent).toContain("starting");
	});

	it("rs-AC-7 / rs-AC-9 mounts SetupGate once ready, stops polling, and stays mounted (sticky)", async () => {
		fleetStatusQueue.push(
			{ supervisor: "reachable", health: "degraded", asOf: "2026-07-01T12:00:00.000Z", daemons: [{ name: "honeycomb", health: "ok", escalation: null }] },
			{ supervisor: "reachable", health: "ok", asOf: "2026-07-01T12:00:00.000Z", daemons: [{ name: "honeycomb", health: "ok", escalation: null }] },
		);
		render(<ReadinessSplash assetBase="assets" pollMs={10} />);

		await waitFor(() => expect(screen.queryByTestId("readiness-splash")).toBeNull());
		// FRESH_SETUP_STATE is SetupGate's own safe-default first render (b-AC-6); reaching it here
		// proves ReadinessSplash actually mounted SetupGate, not merely stopped showing the grid.
		expect(screen.queryByTestId("guided-setup")).toBeTruthy();

		const callsAtTransition = fleetStatusCallCount();
		await new Promise((resolve) => setTimeout(resolve, 60));
		// rs-AC-7: polling stopped, no further /api/fleet-status calls after the ready transition.
		expect(fleetStatusCallCount()).toBe(callsAtTransition);
		// rs-AC-9: sticky, nothing unmounts the now-mounted SetupGate.
		expect(screen.queryByTestId("guided-setup")).toBeTruthy();
	});
});
