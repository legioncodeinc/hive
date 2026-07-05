// @vitest-environment jsdom
/**
 * PRD-003b (l-AC-1, l-AC-7, l-AC-8) — `/login`'s content renders the existing guided-setup device
 * flow, and once `/setup/state.authenticated` flips true it does a HARD navigation to `/` (the
 * server gate, not this component, decides the authoritative next screen — see `gate.ts`).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LoginScreen } from "../../src/dashboard/web/setup-gate.js";

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

describe("LoginScreen", () => {
	let assignSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		assignSpy = vi.fn();
		// jsdom does not implement real navigation; replace `location.assign` with a spy so l-AC-7/
		// l-AC-8 can assert the hard-navigation call without jsdom logging a "not implemented" error.
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...window.location, assign: assignSpy },
		});
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("l-AC-1 renders the existing guided-setup device flow when logged out", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ authenticated: false, credentials: { deeplake: false, honeycomb: false, hivemind: false }, phase: "fresh", priorTool: { hivemind: "absent" }, firstTimeSetupComplete: false, warmup: { enabled: false, live: false, warm: false } })),
		);

		render(<LoginScreen assetBase="assets" />);

		await waitFor(() => expect(screen.getByTestId("guided-setup")).toBeTruthy());
		expect(assignSpy).not.toHaveBeenCalled();
	});

	it("l-AC-7 / l-AC-8 hard-navigates to `/` once /setup/state reports authenticated:true", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ authenticated: true, credentials: { deeplake: true, honeycomb: true, hivemind: false }, phase: "linked", priorTool: { hivemind: "absent" }, firstTimeSetupComplete: true, warmup: { enabled: false, live: false, warm: false } })),
		);

		render(<LoginScreen assetBase="assets" />);

		await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/"));
		// Never a client-side swap into a dashboard/Shell subtree — this screen renders nothing
		// further once the navigation is in flight (the module's authenticated branch).
		expect(screen.queryByTestId("guided-setup")).toBeNull();
	});

	it("l-AC-6-adjacent: a failed /setup/state poll keeps rendering guided-setup, never navigates", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false)));

		render(<LoginScreen assetBase="assets" />);

		await waitFor(() => expect(screen.getByTestId("guided-setup")).toBeTruthy());
		expect(assignSpy).not.toHaveBeenCalled();
	});

	it("the grant view offers a Restart-login button that mints a fresh code (closed-tab recovery)", async () => {
		const codes = ["OLDC-0000", "NEWC-1111"];
		let loginCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("/setup/login")) {
					const user_code = codes[Math.min(loginCalls, codes.length - 1)];
					loginCalls += 1;
					return jsonResponse({ user_code, verification_uri: "https://deeplake.ai/device" });
				}
				return jsonResponse({ authenticated: false, credentials: { deeplake: false, honeycomb: false, hivemind: false }, phase: "fresh", priorTool: { hivemind: "absent" }, firstTimeSetupComplete: false, warmup: { enabled: false, live: false, warm: false } });
			}),
		);

		render(<LoginScreen assetBase="assets" />);
		await waitFor(() => expect(screen.getByTestId("guided-setup")).toBeTruthy());

		screen.getByText("First time setup").click();
		await waitFor(() => expect(screen.getByTestId("setup-grant").textContent).toContain("OLDC-0000"));

		screen.getByTestId("setup-restart-login").click();
		await waitFor(() => expect(screen.getByTestId("setup-grant").textContent).toContain("NEWC-1111"));
		expect(loginCalls).toBe(2);
	});
});
