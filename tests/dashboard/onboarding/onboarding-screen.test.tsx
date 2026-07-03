// @vitest-environment jsdom
/**
 * PRD-009b, the `/onboarding` top-level state machine. Covers ob-AC-2 (the UI reflects detection
 * truth, never an assumed product set), ob-AC-3 (the fully-installed + healthy short-circuit),
 * ob-AC-6 (Standard installs the fixed remaining order with no further questions), and
 * ob-AC-16/ob-AC-17 (re-entry resumes straight into the mid-flight product, re-attaching rather
 * than re-offering the hero or re-POSTing).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DetectResponse, HealthResponse, InstallProgressEvent, ProductInstallState } from "../../../src/dashboard/web/onboarding/contracts.js";
import type { OnboardingClient } from "../../../src/dashboard/web/onboarding/onboarding-client.js";
import { OnboardingScreen } from "../../../src/dashboard/web/onboarding/onboarding-screen.js";

function detection(states: Partial<Record<"honeycomb" | "doctor" | "hive" | "nectar", ProductInstallState>>): DetectResponse {
	const products: DetectResponse["products"] = {};
	for (const [name, state] of Object.entries(states)) {
		(products as Record<string, { state: ProductInstallState }>)[name] = { state };
	}
	return { products };
}

function fakeClient(options: { readonly detect: DetectResponse; readonly health: HealthResponse }) {
	let installListener: ((event: InstallProgressEvent) => void) | null = null;
	const startInstall = vi.fn(async (product: string) => ({ product, state: "install_in_progress" as const }));
	const subscribeInstallEvents = vi.fn((_p: string, onEvent: (e: InstallProgressEvent) => void) => {
		installListener = onEvent;
		return () => {
			installListener = null;
		};
	});
	const client = {
		detect: vi.fn(async () => options.detect),
		startInstall,
		subscribeInstallEvents,
		health: vi.fn(async () => options.health),
		complete: vi.fn(async () => {}),
		sendEvent: vi.fn(),
	} as unknown as OnboardingClient;
	return { client, startInstall, subscribeInstallEvents, emit: (e: InstallProgressEvent) => installListener?.(e) };
}

const HEALTHY: HealthResponse = { ready: true, status: { supervisor: "reachable", health: "ok", daemons: [], asOf: "t1" } };
const UNHEALTHY: HealthResponse = { ready: false, status: { supervisor: "unreachable", daemons: [] } };

afterEach(() => {
	cleanup();
});

describe("OnboardingScreen", () => {
	it("ob-AC-2: reflects detection truth, an already-installed product is never offered again on Standard", async () => {
		const { client } = fakeClient({
			detect: detection({ hive: "installed", doctor: "installed", honeycomb: "not_installed", nectar: "not_installed" }),
			health: UNHEALTHY,
		});

		render(<OnboardingScreen client={client} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-hero")).toBeTruthy());

		fireEvent.click(screen.getByTestId("onboarding-standard-button"));

		// Doctor is already installed (per detection), the fixed order skips straight to Honeycomb.
		await waitFor(() => expect(screen.getByTestId("onboarding-install-card-honeycomb")).toBeTruthy());
		expect(screen.queryByTestId("onboarding-install-card-doctor")).toBeNull();
	});

	it("ob-AC-3: a fully-installed, healthy machine short-circuits, no hero, no picker, no install offered", async () => {
		const { client, startInstall } = fakeClient({
			detect: detection({ hive: "installed", doctor: "installed", honeycomb: "installed", nectar: "installed" }),
			health: HEALTHY,
		});

		render(<OnboardingScreen client={client} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-short-circuit")).toBeTruthy());
		expect(screen.queryByTestId("onboarding-hero")).toBeNull();
		expect(startInstall).not.toHaveBeenCalled();

		const onShortCircuitNavigate = vi.fn();
		cleanup();
		const second = fakeClient({
			detect: detection({ hive: "installed", doctor: "installed", honeycomb: "installed", nectar: "installed" }),
			health: HEALTHY,
		});
		render(<OnboardingScreen client={second.client} onShortCircuitNavigate={onShortCircuitNavigate} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-go-to-dashboard")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-go-to-dashboard"));
		expect(onShortCircuitNavigate).toHaveBeenCalledTimes(1);
	});

	it("ob-AC-6: Standard walks the fixed order (Doctor, Honeycomb, Nectar) with no further questions", async () => {
		const { client } = fakeClient({
			detect: detection({ hive: "installed", doctor: "not_installed", honeycomb: "not_installed", nectar: "not_installed" }),
			health: UNHEALTHY,
		});

		render(<OnboardingScreen client={client} minDwellMs={0} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-hero")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-standard-button"));

		// No picker ever renders on the Standard path.
		expect(screen.queryByTestId("onboarding-picker")).toBeNull();
		await waitFor(() => expect(screen.getByTestId("onboarding-install-card-doctor")).toBeTruthy());
	});

	it("ob-AC-16/ob-AC-17: resumes straight into the mid-flight product, re-attaching without a new install POST", async () => {
		const { client, startInstall, subscribeInstallEvents } = fakeClient({
			detect: detection({ hive: "installed", doctor: "installed", honeycomb: "install_in_progress", nectar: "not_installed" }),
			health: UNHEALTHY,
		});

		render(<OnboardingScreen client={client} minDwellMs={0} />);

		// Skips the hero entirely, an install was already under way.
		await waitFor(() => expect(screen.getByTestId("onboarding-install-card-honeycomb")).toBeTruthy());
		expect(screen.queryByTestId("onboarding-hero")).toBeNull();
		expect(startInstall).not.toHaveBeenCalled();
		expect(subscribeInstallEvents).toHaveBeenCalledWith("honeycomb", expect.any(Function));
	});

	it("fires onboarding_started exactly once for a valid (test-injected) client", async () => {
		const { client } = fakeClient({ detect: detection({ hive: "installed" }), health: UNHEALTHY });
		render(<OnboardingScreen client={client} />);
		await waitFor(() => expect(client.sendEvent).toHaveBeenCalledWith("onboarding_started"));
		expect((client.sendEvent as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "onboarding_started")).toHaveLength(1);
	});

	it("fires mode_selected with the chosen mode when Advanced is picked", async () => {
		const { client } = fakeClient({
			detect: detection({ hive: "installed", doctor: "not_installed", honeycomb: "not_installed", nectar: "not_installed" }),
			health: UNHEALTHY,
		});
		render(<OnboardingScreen client={client} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-hero")).toBeTruthy());

		fireEvent.click(screen.getByTestId("onboarding-advanced-button"));
		await waitFor(() => expect(screen.getByTestId("onboarding-picker")).toBeTruthy());
		expect(client.sendEvent).toHaveBeenCalledWith("mode_selected", { mode: "advanced" });
	});
});
