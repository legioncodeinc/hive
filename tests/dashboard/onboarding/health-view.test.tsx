// @vitest-environment jsdom
/**
 * PRD-009b ob-AC-13, the green-light health step: polls `/api/onboarding/health`, renders a
 * per-daemon row, and advances ONLY once the required fleet reads ready.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { HealthView } from "../../../src/dashboard/web/onboarding/health-view.js";
import type { OnboardingClient } from "../../../src/dashboard/web/onboarding/onboarding-client.js";

afterEach(() => {
	cleanup();
});

describe("HealthView", () => {
	it("ob-AC-13: renders a per-daemon row from the health status and does not advance while not ready", async () => {
		const client = {
			health: vi.fn(async () => ({
				ready: false,
				status: { supervisor: "reachable" as const, health: "degraded" as const, daemons: [{ name: "honeycomb", health: "degraded" as const, escalation: null }], asOf: "t1" },
			})),
		} as unknown as OnboardingClient;
		const onReady = vi.fn();

		render(<HealthView client={client} onReady={onReady} pollMs={10} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-health-row-honeycomb")).toBeTruthy());
		expect(screen.getByTestId("onboarding-health-row-honeycomb").getAttribute("data-state")).toBe("degraded");
		expect(onReady).not.toHaveBeenCalled();
	});

	it("ob-AC-13: advances via onReady only once the health read reports ready:true", async () => {
		let ready = false;
		const client = {
			health: vi.fn(async () => ({
				ready,
				status: {
					supervisor: "reachable" as const,
					health: ready ? ("ok" as const) : ("degraded" as const),
					daemons: [{ name: "honeycomb", health: ready ? ("ok" as const) : ("degraded" as const), escalation: null }],
					asOf: "t1",
				},
			})),
		} as unknown as OnboardingClient;
		const onReady = vi.fn();

		render(<HealthView client={client} onReady={onReady} pollMs={10} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-health-row-honeycomb")).toBeTruthy());
		expect(onReady).not.toHaveBeenCalled();

		ready = true;
		await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
	});
});
