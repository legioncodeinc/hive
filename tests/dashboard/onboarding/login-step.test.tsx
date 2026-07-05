// @vitest-environment jsdom
/**
 * PRD-009b, the onboarding login step. Covers ob-AC-14 (the `user_code` + verification link
 * rendered from the exact `GuidedSetup` wire shape) and ob-AC-15 (a hard navigation once
 * `/setup/state.authenticated` flips true, after the `dashboard_reached` event and the best-effort
 * `/api/onboarding/complete` beacon).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { FRESH_SETUP_STATE, type SetupLoginWire, type SetupStateWire, type WireClient } from "../../../src/dashboard/web/wire.js";
import { LoginStep } from "../../../src/dashboard/web/onboarding/login-step.js";
import type { OnboardingClient } from "../../../src/dashboard/web/onboarding/onboarding-client.js";

function fakeWire(overrides: Partial<WireClient> = {}): WireClient {
	return {
		setupLogin: vi.fn(async (): Promise<SetupLoginWire | null> => ({ user_code: "ABCD-1234", verification_uri: "https://deeplake.ai/device" })),
		setupState: vi.fn(async (): Promise<SetupStateWire> => FRESH_SETUP_STATE),
		...overrides,
	} as unknown as WireClient;
}

function fakeOnboardingClient(overrides: Partial<OnboardingClient> = {}): OnboardingClient {
	return {
		sendEvent: vi.fn(),
		complete: vi.fn(async () => {}),
		...overrides,
	} as unknown as OnboardingClient;
}

afterEach(() => {
	cleanup();
});

describe("LoginStep", () => {
	it("ob-AC-14: begins the device flow automatically and renders the user_code + verification link", async () => {
		const wire = fakeWire();
		const onboardingClient = fakeOnboardingClient();

		render(<LoginStep onboardingClient={onboardingClient} wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-login-code").textContent).toBe("ABCD-1234"));
		expect(screen.getByTestId("onboarding-login-verification-link").getAttribute("href")).toBe("https://deeplake.ai/device");
		// login_shown fires in a post-grant effect tick; await it rather than asserting synchronously
		// (the synchronous form races the effect on slower runners, e.g. Windows CI).
		await waitFor(() => expect(onboardingClient.sendEvent).toHaveBeenCalledWith("login_shown"));
	});

	it("ob-AC-14: prefers verification_uri_complete over verification_uri when both are present", async () => {
		const wire = fakeWire({
			setupLogin: vi.fn(async () => ({
				user_code: "WXYZ-9999",
				verification_uri: "https://deeplake.ai/device",
				verification_uri_complete: "https://deeplake.ai/device?code=WXYZ-9999",
			})),
		});
		render(<LoginStep onboardingClient={fakeOnboardingClient()} wire={wire} />);

		await waitFor(() =>
			expect(screen.getByTestId("onboarding-login-verification-link").getAttribute("href")).toBe("https://deeplake.ai/device?code=WXYZ-9999"),
		);
	});

	it("a failed device-flow begin shows a Retry button that mints a fresh grant (never a dead end)", async () => {
		const setupLogin = vi
			.fn<() => Promise<SetupLoginWire | null>>()
			.mockResolvedValueOnce(null)
			.mockResolvedValue({ user_code: "NEWC-0001", verification_uri: "https://deeplake.ai/device" });
		const wire = fakeWire({ setupLogin: setupLogin as unknown as WireClient["setupLogin"] });

		render(<LoginStep onboardingClient={fakeOnboardingClient()} wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-login-error")).toBeTruthy());
		screen.getByTestId("onboarding-login-retry").click();
		await waitFor(() => expect(screen.getByTestId("onboarding-login-code").textContent).toBe("NEWC-0001"));
		expect(setupLogin).toHaveBeenCalledTimes(2);
	});

	it("the grant view carries a Restart-login button that replaces a stale code with a fresh one", async () => {
		const setupLogin = vi
			.fn<() => Promise<SetupLoginWire | null>>()
			.mockResolvedValueOnce({ user_code: "OLDC-0000", verification_uri: "https://deeplake.ai/device" })
			.mockResolvedValue({ user_code: "NEWC-1111", verification_uri: "https://deeplake.ai/device" });
		const wire = fakeWire({ setupLogin: setupLogin as unknown as WireClient["setupLogin"] });

		render(<LoginStep onboardingClient={fakeOnboardingClient()} wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-login-code").textContent).toBe("OLDC-0000"));
		screen.getByTestId("onboarding-login-restart").click();
		await waitFor(() => expect(screen.getByTestId("onboarding-login-code").textContent).toBe("NEWC-1111"));
		expect(setupLogin).toHaveBeenCalledTimes(2);
	});

	it("ts-AC-1: once authenticated flips true, reports up to the parent without terminal handoff", async () => {
		let authenticated = false;
		const wire = fakeWire({
			setupState: vi.fn(async () => ({ ...FRESH_SETUP_STATE, authenticated })),
		});
		const onboardingClient = fakeOnboardingClient();
		const onAuthenticated = vi.fn();

		render(<LoginStep onboardingClient={onboardingClient} wire={wire} onAuthenticated={onAuthenticated} pollMs={10} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-login-step")).toBeTruthy());

		authenticated = true;
		await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));

		expect(onboardingClient.sendEvent).not.toHaveBeenCalledWith("dashboard_reached");
		expect(onboardingClient.complete).not.toHaveBeenCalled();
	});
});
