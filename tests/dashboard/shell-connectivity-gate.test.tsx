// @vitest-environment jsdom
/**
 * PRD-001c c-AC-3 (UI layer): the shell connectivity gate is per-route-owner, not honeycomb-global.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { Shell } from "../../src/dashboard/web/app.js";
import { EMPTY_SETTINGS, type HealthProbe, type HiveGraphStatusResultWire, type WireClient } from "../../src/dashboard/web/wire.js";

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function nectarStatusUp(): HiveGraphStatusResultWire {
	return {
		queueDepth: 0,
		describeStatus: { pending: 0, described: 0, failed: 0, "skipped-too-large": 0, "skipped-binary": 0, "skipped-deleted": 0 },
		costSpentUsd: 0,
		degraded: false,
		unreachable: false,
	};
}

function makeShellWire(options: { honeycombUp: boolean; nectarUp: boolean }): WireClient {
	const healthProbe: HealthProbe = { up: options.honeycombUp, reasons: null };
	const nectarStatus: HiveGraphStatusResultWire = options.nectarUp
		? nectarStatusUp()
		: { ...nectarStatusUp(), unreachable: true };

	return {
		health: vi.fn(async () => healthProbe),
		hiveGraphStatus: vi.fn(async () => nectarStatus),
		settings: vi.fn(async () => EMPTY_SETTINGS),
		scopeProjects: vi.fn(async () => []),
		scopeOrgs: vi.fn(async () => []),
		scopeWorkspaces: vi.fn(async () => ({ workspaces: [] })),
		pollinate: vi.fn(async () => ({ triggered: false })),
	} as unknown as WireClient;
}

describe("Shell per-owner connectivity gate", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = requestUrl(input);
				if (url.includes("/api/registered-services")) return jsonResponse({ names: ["honeycomb", "nectar"] });
				if (url.includes("/api/fleet-status")) {
					return jsonResponse({ supervisor: "reachable", health: "ok", asOf: "t1", daemons: [] });
				}
				return jsonResponse({}, false);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		window.history.replaceState(null, "", "/");
		vi.unstubAllGlobals();
	});

	it("c-AC-3 does not blank a nectar-owned page when honeycomb alone is down", async () => {
		window.history.replaceState(null, "", "/hive-graph");
		render(<Shell client={makeShellWire({ honeycombUp: false, nectarUp: true })} assetBase="assets" />);

		await waitFor(() => expect(screen.queryByText("Daemon not reachable")).toBeNull());
		await waitFor(() => expect(screen.getByRole("heading", { name: "Hive Graph" })).toBeTruthy());
	});

	it("c-AC-3 blanks a honeycomb-owned page when honeycomb is down", async () => {
		window.history.replaceState(null, "", "/memories");
		render(<Shell client={makeShellWire({ honeycombUp: false, nectarUp: true })} assetBase="assets" />);

		await waitFor(() => expect(screen.getByText("Daemon not reachable")).toBeTruthy());
	});

	it("c-AC-3 blanks a nectar-owned page when nectar is down but honeycomb is up", async () => {
		window.history.replaceState(null, "", "/hive-graph");
		render(<Shell client={makeShellWire({ honeycombUp: true, nectarUp: false })} assetBase="assets" />);

		await waitFor(() => expect(screen.getByText("Daemon not reachable")).toBeTruthy());
		expect(screen.queryByRole("heading", { name: "Hive Graph" })).toBeNull();
	});
});
