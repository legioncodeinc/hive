// @vitest-environment jsdom
/**
 * the-hive PRD-005a — the top health rail. Present on every route (hr-AC-1), shares the
 * telemetry hook's REST-fallback path here (jsdom has no `EventSource`).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HealthRail } from "../../src/dashboard/web/health-rail.js";

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("HealthRail", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: ["honeycomb", "hivenectar"] });
				if (url.includes("/api/fleet-status")) {
					return jsonResponse({
						supervisor: "reachable",
						health: "ok",
						asOf: "2026-07-01T12:00:00.000Z",
						daemons: [
							{ name: "honeycomb", health: "ok", escalation: null },
							{ name: "hivenectar", health: "degraded", escalation: null },
						],
					});
				}
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("hr-AC-1/hr-AC-2: renders one pill per service using the shared status vocabulary", async () => {
		render(<HealthRail />);
		await waitFor(() => expect(screen.getByTestId("health-rail-pill-honeycomb")).toBeTruthy());
		expect(screen.getByTestId("health-rail-pill-hivenectar")).toBeTruthy();
		expect(screen.getByTestId("health-rail-pill-hivenectar").getAttribute("data-state")).toBe("degraded");
	});

	it("exposes each pill's STATE in its accessible text, not only in `title`/the aria-hidden icon", async () => {
		render(<HealthRail />);
		await waitFor(() => expect(screen.getByTestId("health-rail-pill-hivenectar")).toBeTruthy());
		// The live region announces text content; a screen reader must hear "hivenectar: degraded",
		// never a bare "hivenectar" with the state trapped in a tooltip or a hidden icon.
		expect(screen.getByTestId("health-rail-pill-hivenectar").textContent).toContain("degraded");
		expect(screen.getByTestId("health-rail-pill-honeycomb").textContent).toMatch(/honeycomb: (warming|active)/);
	});

	it("hr-AC-4: a degraded service does not remove the rail or the other pill (never disappears)", async () => {
		render(<HealthRail />);
		await waitFor(() => expect(screen.getByTestId("health-rail")).toBeTruthy());
		expect(screen.getByTestId("health-rail-pill-honeycomb")).toBeTruthy();
	});

	it("links to the /health page when a handler is supplied", async () => {
		const onOpenHealth = vi.fn();
		render(<HealthRail onOpenHealth={onOpenHealth} />);
		await waitFor(() => expect(screen.getByTestId("health-rail-open-health")).toBeTruthy());
		fireEvent.click(screen.getByTestId("health-rail-open-health"));
		expect(onOpenHealth).toHaveBeenCalledTimes(1);
	});
});
