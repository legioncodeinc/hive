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
		expect(onboardingClient.sendEvent).toHaveBeenCalledWith("login_shown");
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

	it("ob-AC-15: once authenticated flips true, fires dashboard_reached, completes, then navigates", async () => {
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

		expect(onboardingClient.sendEvent).toHaveBeenCalledWith("dashboard_reached");
		expect(onboardingClient.complete).toHaveBeenCalledTimes(1);
		// Never a client-side swap into a dashboard subtree, l-AC-7/l-AC-8's discipline, reused here.
		expect(screen.queryByTestId("onboarding-login-step")).toBeNull();
	});
});
