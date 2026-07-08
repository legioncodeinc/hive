// @vitest-environment jsdom
/**
 * PRD-006c: the onboarding "Connect your coding assistant" step. Covers c-AC-2 (a connected result
 * shows the success state + Continue), c-AC-3 (a cli-absent/agent-absent result shows the
 * install-then-retry state with a docs link and a Retry that re-runs connect), and c-AC-5 (a ghost
 * Skip is always present and never blocks). Mirrors `login-step.test.tsx`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HarnessConnectStep, CLAUDE_CODE_INSTALL_DOCS } from "../../../src/dashboard/web/onboarding/harness-connect-step.js";
import type { HarnessConnectResult } from "../../../src/dashboard/web/onboarding/onboarding-client.js";
import type { OnboardingClient } from "../../../src/dashboard/web/onboarding/onboarding-client.js";

function fakeClient(connectHarness: OnboardingClient["connectHarness"]): OnboardingClient {
	return {
		sendEvent: vi.fn(),
		complete: vi.fn(async () => {}),
		connectHarness,
	} as unknown as OnboardingClient;
}

afterEach(() => cleanup());

describe("HarnessConnectStep", () => {
	it("c-AC-2: a connected result shows the success state + a Continue that advances", async () => {
		const onDone = vi.fn();
		const connectHarness = vi.fn(async (): Promise<HarnessConnectResult> => ({ harness: "claude-code", status: "connected" }));

		render(<HarnessConnectStep onboardingClient={fakeClient(connectHarness)} onDone={onDone} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-connected")).toBeTruthy());
		fireEvent.click(screen.getByTestId("harness-connect-continue"));
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("c-AC-3: a cli-absent result shows install-then-retry with a docs link; Retry re-runs connect", async () => {
		const connectHarness = vi
			.fn<() => Promise<HarnessConnectResult>>()
			.mockResolvedValueOnce({ harness: "claude-code", status: "cli-absent" })
			.mockResolvedValue({ harness: "claude-code", status: "connected" });

		render(<HarnessConnectStep onboardingClient={fakeClient(connectHarness as OnboardingClient["connectHarness"])} onDone={vi.fn()} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-install")).toBeTruthy());
		expect(screen.getByTestId("harness-connect-install-link").getAttribute("href")).toBe(CLAUDE_CODE_INSTALL_DOCS);

		fireEvent.click(screen.getByTestId("harness-connect-retry"));
		await waitFor(() => expect(screen.getByTestId("harness-connect-connected")).toBeTruthy());
		expect(connectHarness).toHaveBeenCalledTimes(2);
	});

	it("c-AC-3: an agent-absent result also shows the install-then-retry state", async () => {
		const connectHarness = vi.fn(async (): Promise<HarnessConnectResult> => ({ harness: "claude-code", status: "agent-absent" }));
		render(<HarnessConnectStep onboardingClient={fakeClient(connectHarness)} onDone={vi.fn()} />);
		await waitFor(() => expect(screen.getByTestId("harness-connect-install")).toBeTruthy());
	});

	it("c-AC-5: a ghost Skip is available and advances without blocking (install state)", async () => {
		const onDone = vi.fn();
		const connectHarness = vi.fn(async (): Promise<HarnessConnectResult> => ({ harness: "claude-code", status: "cli-absent" }));

		render(<HarnessConnectStep onboardingClient={fakeClient(connectHarness)} onDone={onDone} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-install")).toBeTruthy());
		fireEvent.click(screen.getByTestId("harness-connect-skip"));
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("c-AC-5: an error result shows a generic retry + Skip (never a dead end)", async () => {
		const onDone = vi.fn();
		const connectHarness = vi.fn(async (): Promise<HarnessConnectResult> => ({ harness: "claude-code", status: "error", detail: "timeout" }));

		render(<HarnessConnectStep onboardingClient={fakeClient(connectHarness)} onDone={onDone} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-error")).toBeTruthy());
		expect(screen.getByTestId("harness-connect-retry")).toBeTruthy();
		fireEvent.click(screen.getByTestId("harness-connect-skip"));
		expect(onDone).toHaveBeenCalledTimes(1);
	});
});
