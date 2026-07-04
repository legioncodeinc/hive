// @vitest-environment jsdom
/**
 * PRD-009b, the per-product guided install card. Covers ob-AC-8/ob-AC-10 (full-screen card with
 * logo/title/benefit copy/npm-safety copy), ob-AC-9 (staged progress, never a percent), ob-AC-11
 * (the minimum ~30s dwell that never masks a failure), ob-AC-12 (truthful failure + retry), and the
 * ob-AC-17 re-attach precedent (an `install_in_progress` card subscribes without re-POSTing).
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { InstallProgressEvent, ProductDetection } from "../../../src/dashboard/web/onboarding/contracts.js";
import { InstallCard } from "../../../src/dashboard/web/onboarding/install-card.js";
import type { OnboardingClient } from "../../../src/dashboard/web/onboarding/onboarding-client.js";

const NOT_INSTALLED: ProductDetection = { state: "not_installed" };

function fakeClient(overrides: Partial<OnboardingClient> = {}) {
	let listener: ((event: InstallProgressEvent) => void) | null = null;
	const startInstall = vi.fn(async (product: string) => ({ product, state: "install_in_progress" as const }));
	const subscribeInstallEvents = vi.fn((_product: string, onEvent: (event: InstallProgressEvent) => void) => {
		listener = onEvent;
		return () => {
			listener = null;
		};
	});
	const client = {
		detect: vi.fn(),
		startInstall,
		subscribeInstallEvents,
		health: vi.fn(),
		complete: vi.fn(),
		sendEvent: vi.fn(),
		...overrides,
	} as unknown as OnboardingClient;
	return {
		client,
		startInstall: startInstall,
		subscribeInstallEvents: subscribeInstallEvents,
		emit: (event: InstallProgressEvent) => listener?.(event),
	};
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("InstallCard", () => {
	it("ob-AC-8/ob-AC-10: renders full-screen with the product logo, title, benefit copy, and npm-safety copy", () => {
		const { client } = fakeClient();
		render(<InstallCard product="doctor" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={() => {}} />);

		const card = screen.getByTestId("onboarding-install-card-doctor");
		expect(card.style.minHeight).toBe("100vh");
		expect(card.textContent).toContain("Doctor");
		expect(card.textContent).toMatch(/keeps your daemons alive/i);
		expect(screen.getByTestId("onboarding-npm-safety-doctor").textContent).toMatch(/signed and provenance verified/i);
	});

	it("ob-AC-9: renders the staged progress from SSE frames and never a percent bar", async () => {
		const { client, emit } = fakeClient();
		render(<InstallCard product="honeycomb" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={() => {}} />);

		await act(async () => {
			await Promise.resolve();
		});
		act(() => emit({ stage: "downloading" }));

		const stageList = screen.getByTestId("onboarding-install-stage-honeycomb");
		expect(stageList.getAttribute("data-current-stage")).toBe("downloading");
		expect(stageList.textContent).not.toMatch(/%/);
		expect(stageList.textContent).toMatch(/downloading/i);
	});

	it("ob-AC-17: a card that opens `install_in_progress` re-attaches SSE WITHOUT re-POSTing install", () => {
		const { client, startInstall, subscribeInstallEvents } = fakeClient();
		render(
			<InstallCard
				product="nectar"
				initialDetection={{ state: "install_in_progress" }}
				client={client}
				assetBase="assets"
				onAdvance={() => {}}
			/>,
		);

		expect(startInstall).not.toHaveBeenCalled();
		expect(subscribeInstallEvents).toHaveBeenCalledTimes(1);
	});

	it("ob-AC-11: holds a card that completes early until the minimum dwell elapses, then advances", async () => {
		vi.useFakeTimers();
		const { client, emit } = fakeClient();
		const onAdvance = vi.fn();
		render(<InstallCard product="doctor" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={onAdvance} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		act(() => emit({ stage: "completed" }));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_500);
		});
		expect(onAdvance).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(onAdvance).toHaveBeenCalledTimes(1);
	});

	it("ob-AC-11: a long install simply holds until it reaches a terminal state (no premature advance)", async () => {
		vi.useFakeTimers();
		const { client } = fakeClient();
		const onAdvance = vi.fn();
		render(<InstallCard product="doctor" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={onAdvance} minDwellMs={1_000} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(onAdvance).not.toHaveBeenCalled();
	});

	it("ob-AC-11/ob-AC-12: a failure surfaces immediately even BEFORE the dwell elapses (never masked)", async () => {
		vi.useFakeTimers();
		const { client, emit } = fakeClient();
		const onAdvance = vi.fn();
		render(<InstallCard product="doctor" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={onAdvance} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		act(() => emit({ stage: "failed", detail: "npm exited with code 1" }));

		expect(screen.getByTestId("onboarding-install-error-doctor").textContent).toContain("npm exited with code 1");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(40_000);
		});
		expect(onAdvance).not.toHaveBeenCalled();
	});

	it("ob-AC-12: a card that opens `install_failed` shows the truthful error immediately, with no auto network activity", () => {
		const { client, startInstall, subscribeInstallEvents } = fakeClient();
		render(
			<InstallCard
				product="doctor"
				initialDetection={{ state: "install_failed", error: { stage: "downloading", summary: "registry timeout" } }}
				client={client}
				assetBase="assets"
				onAdvance={() => {}}
			/>,
		);

		expect(screen.getByTestId("onboarding-install-error-doctor").textContent).toContain("registry timeout");
		expect(startInstall).not.toHaveBeenCalled();
		expect(subscribeInstallEvents).not.toHaveBeenCalled();
	});

	it("ob-AC-12: clicking Retry re-POSTs the install and re-subscribes", async () => {
		const { client, startInstall, subscribeInstallEvents } = fakeClient();
		render(
			<InstallCard
				product="doctor"
				initialDetection={{ state: "install_failed", error: { stage: "downloading", summary: "registry timeout" } }}
				client={client}
				assetBase="assets"
				onAdvance={() => {}}
			/>,
		);

		fireEvent.click(screen.getByTestId("onboarding-retry-doctor"));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(startInstall).toHaveBeenCalledWith("doctor");
		expect(subscribeInstallEvents).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("onboarding-install-error-doctor")).toBeNull();
	});

	it("is-AC-5: a 409 unpublished refusal renders honest npm copy with retry", async () => {
		const { client } = fakeClient({
			startInstall: vi.fn(async () => ({ error: "unpublished" as const })),
		});
		render(<InstallCard product="honeycomb" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={() => {}} />);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const error = screen.getByTestId("onboarding-install-error-honeycomb");
		expect(error.textContent).toMatch(/not published to npm/i);
		expect(screen.getByTestId("onboarding-retry-honeycomb")).toBeTruthy();
	});

	it("is-AC-5: a 409 manifest_unresolved refusal renders honest manifest copy with retry", async () => {
		const { client } = fakeClient({
			startInstall: vi.fn(async () => ({ error: "manifest_unresolved" as const })),
		});
		render(<InstallCard product="nectar" initialDetection={NOT_INSTALLED} client={client} assetBase="assets" onAdvance={() => {}} />);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const error = screen.getByTestId("onboarding-install-error-nectar");
		expect(error.textContent).toMatch(/manifest could not be resolved/i);
		expect(screen.getByTestId("onboarding-retry-nectar")).toBeTruthy();
	});
});
