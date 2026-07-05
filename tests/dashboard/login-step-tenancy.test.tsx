/**
 * @vitest-environment jsdom
 * PRD-011a LoginStep handoff (ts-AC-1).
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginStep } from "../../src/dashboard/web/onboarding/login-step.js";
import type { OnboardingClient } from "../../src/dashboard/web/onboarding/onboarding-client.js";
import { FRESH_SETUP_STATE, type WireClient } from "../../src/dashboard/web/wire.js";

afterEach(() => cleanup());

describe("LoginStep PRD-011 handoff", () => {
	it("ts-AC-1 does not fire dashboard_reached or navigate when authenticated; reports up instead", async () => {
		const onAuthenticated = vi.fn();
		const onboarding: OnboardingClient = {
			detect: vi.fn(),
			startInstall: vi.fn(),
			subscribeInstallEvents: vi.fn(() => () => {}),
			health: vi.fn(),
			complete: vi.fn(),
			sendEvent: vi.fn(),
		};
		let poll = 0;
		const wire: WireClient = {
			setupState: vi.fn(async () => {
				poll += 1;
				return poll >= 2 ? { ...FRESH_SETUP_STATE, authenticated: true } : FRESH_SETUP_STATE;
			}),
			setupLogin: vi.fn(async () => ({ user_code: "ABCD-1234", verification_uri: "https://example.com" })),
		} as WireClient;

		render(<LoginStep onboardingClient={onboarding} wire={wire} onAuthenticated={onAuthenticated} pollMs={10} />);

		await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
		expect(onboarding.sendEvent).not.toHaveBeenCalledWith("dashboard_reached");
		expect(onboarding.complete).not.toHaveBeenCalled();
	});
});
