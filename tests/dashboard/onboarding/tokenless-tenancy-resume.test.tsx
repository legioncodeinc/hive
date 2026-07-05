// @vitest-environment jsdom
/**
 * PRD-011c C-1: the gate's tokenless `/onboarding` redirect resumes at the tenancy step
 * (tg-AC-8 / ts-AC-10), never dead-ends on the expired-link notice for an installed,
 * authenticated, tenancy-unselected machine. jsdom's default URL carries no `?t=` token, so
 * every mount here is exactly the gate-redirect shape.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OnboardingScreen } from "../../../src/dashboard/web/onboarding/onboarding-screen.js";
import type { TenancyClient } from "../../../src/dashboard/web/onboarding/tenancy-client.js";
import { FRESH_SETUP_STATE, type SetupTenancyResultWire, type WireClient } from "../../../src/dashboard/web/wire.js";

afterEach(() => {
	cleanup();
	// The W-4 loop counter is per-tab sessionStorage; keep tests hermetic across this file.
	sessionStorage.clear();
});

function tenancyResult(overrides: Partial<SetupTenancyResultWire> = {}): SetupTenancyResultWire {
	return {
		pending: true,
		selected: false,
		authenticated: true,
		org: null,
		workspace: null,
		unreachable: false,
		...overrides,
	};
}

function fakeWire(options: { authenticated: boolean; selected: boolean; unreachable?: boolean }): WireClient {
	return {
		setupState: vi.fn(async () => ({ ...FRESH_SETUP_STATE, authenticated: options.authenticated })),
		setupTenancy: vi.fn(async () =>
			tenancyResult({
				authenticated: options.authenticated,
				selected: options.selected,
				unreachable: options.unreachable ?? false,
			}),
		),
	} as unknown as WireClient;
}

function fakeTenancyClient(): TenancyClient {
	return {
		setupTenancy: vi.fn(async () => tenancyResult()),
		listOrgs: vi.fn(async () => ({ orgs: [{ id: "o", name: "Org" }] })),
		listWorkspaces: vi.fn(async () => ({ org: "o", workspaces: [{ id: "w", name: "WS" }], canCreate: false })),
		selectTenancy: vi.fn(async () => ({
			selected: true as const,
			org: { id: "o", name: "Org" },
			workspace: { id: "w", name: "WS" },
			reminted: false,
		})),
		createWorkspace: vi.fn(),
	};
}

describe("OnboardingScreen tokenless tenancy resume (C-1)", () => {
	it("tg-AC-8 / ts-AC-10 a tokenless mount on an installed+authenticated+unselected machine renders the tenancy step, not the expired-link notice, and can complete selection", async () => {
		const wire = fakeWire({ authenticated: true, selected: false });
		const tenancyClient = fakeTenancyClient();
		const onAuthenticated = vi.fn();

		render(<OnboardingScreen wire={wire} tenancyClient={tenancyClient} onAuthenticated={onAuthenticated} />);

		// The tenancy step renders (tg-AC-8's required landing surface)...
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-step")).toBeTruthy());
		// ...and the expired-link terminal never does (the C-1 dead-end).
		expect(screen.queryByTestId("onboarding-missing-token")).toBeNull();

		// ts-AC-10: the resume is live end to end; the operator completes the selection from here.
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-org-confirm-btn"));
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-workspace-option")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-workspace-option"));
		await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
		expect(tenancyClient.selectTenancy).toHaveBeenCalledWith("o", "w");
	});

	it("tg-AC-8 a tokenless mount that is NOT authenticated falls back to the expired-link notice (the genuine re-run case)", async () => {
		const wire = fakeWire({ authenticated: false, selected: false });

		render(<OnboardingScreen wire={wire} tenancyClient={fakeTenancyClient()} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-missing-token")).toBeTruthy());
		expect(screen.queryByTestId("onboarding-tenancy-step")).toBeNull();
	});

	it("tg-AC-8 a tokenless mount with tenancy already selected hands straight back to the dashboard (no tenancy step, no expired notice)", async () => {
		const wire = fakeWire({ authenticated: true, selected: true });
		const onAuthenticated = vi.fn();

		render(<OnboardingScreen wire={wire} tenancyClient={fakeTenancyClient()} onAuthenticated={onAuthenticated} />);

		await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId("onboarding-tenancy-step")).toBeNull();
		expect(screen.queryByTestId("onboarding-missing-token")).toBeNull();
	});

	it("tg-AC-8 an unreachable tokenless probe fails soft to the expired-link notice, never a fabricated resume", async () => {
		const wire = {
			setupState: vi.fn(async () => FRESH_SETUP_STATE),
			setupTenancy: vi.fn(async () => tenancyResult({ authenticated: false, unreachable: true })),
		} as unknown as WireClient;

		render(<OnboardingScreen wire={wire} tenancyClient={fakeTenancyClient()} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-missing-token")).toBeTruthy());
	});

	it("N-2 a THROWN tokenless probe fails closed to the expired-link notice (no dependence on the wire client's never-throw guarantee)", async () => {
		const wire = {
			setupState: vi.fn(async () => {
				throw new Error("unexpected wire throw");
			}),
			setupTenancy: vi.fn(async () => tenancyResult()),
		} as unknown as WireClient;

		render(<OnboardingScreen wire={wire} tenancyClient={fakeTenancyClient()} />);

		await waitFor(() => expect(screen.getByTestId("onboarding-missing-token")).toBeTruthy());
		expect(screen.queryByTestId("onboarding-tenancy-step")).toBeNull();
	});
});
