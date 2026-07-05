/**
 * @vitest-environment jsdom
 * PRD-011a TenancyStep UI (AC-named).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TENANCY_AUTO_COMPLETE_LIMIT, TenancyStep } from "../../src/dashboard/web/onboarding/tenancy-step.js";
import type { OnboardingClient } from "../../src/dashboard/web/onboarding/onboarding-client.js";
import type { TenancyClient } from "../../src/dashboard/web/onboarding/tenancy-client.js";

afterEach(() => {
	cleanup();
	// The W-4 loop counter is per-tab sessionStorage; keep tests hermetic across this file.
	sessionStorage.clear();
});

function mockOnboardingClient(): OnboardingClient {
	return {
		detect: vi.fn(),
		startInstall: vi.fn(),
		subscribeInstallEvents: vi.fn(() => () => {}),
		health: vi.fn(),
		complete: vi.fn(async () => {}),
		sendEvent: vi.fn(),
	};
}

describe("TenancyStep", () => {
	it("ts-AC-3 renders org confirm for a single-org account", async () => {
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
			listOrgs: vi.fn(async () => ({ orgs: [{ id: "only", name: "Only Org" }] })),
			listWorkspaces: vi.fn(),
			selectTenancy: vi.fn(),
			createWorkspace: vi.fn(),
		};
		render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={tenancy} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		expect(screen.getByText(/Only Org/)).toBeTruthy();
	});

	it("ts-AC-4 renders every org without preselection in multi-org mode", async () => {
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
			listOrgs: vi.fn(async () => ({
				orgs: [
					{ id: "a", name: "Alpha" },
					{ id: "b", name: "Beta" },
				],
			})),
			listWorkspaces: vi.fn(),
			selectTenancy: vi.fn(),
			createWorkspace: vi.fn(),
		};
		render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={tenancy} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-list")).toBeTruthy());
		expect(screen.getAllByTestId("onboarding-tenancy-org-option")).toHaveLength(2);
	});

	it("ts-AC-7 shows honest empty workspace state when canCreate is false", async () => {
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
			listOrgs: vi.fn(async () => ({ orgs: [{ id: "o", name: "Org" }] })),
			listWorkspaces: vi.fn(async () => ({ org: "o", workspaces: [], canCreate: false })),
			selectTenancy: vi.fn(),
			createWorkspace: vi.fn(),
		};
		render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={tenancy} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-org-confirm-btn"));
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-no-workspaces")).toBeTruthy());
	});

	it("ts-AC-5 lists every workspace by display name with none preselected; selection happens only on an active click", async () => {
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
			listOrgs: vi.fn(async () => ({ orgs: [{ id: "o", name: "Org" }] })),
			listWorkspaces: vi.fn(async () => ({
				org: "o",
				workspaces: [
					{ id: "default", name: "default" },
					{ id: "ws-team", name: "Team Workspace" },
				],
				canCreate: false,
			})),
			selectTenancy: vi.fn(async () => ({ selected: false as const, error: "not persisted in this test" })),
			createWorkspace: vi.fn(),
		};
		render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={tenancy} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-org-confirm-btn"));

		// Every workspace renders by display name; NOTHING was selected without an active click
		// (a `default` entry gets no special treatment, the wrong-org-incident posture).
		await waitFor(() => expect(screen.getAllByTestId("onboarding-tenancy-workspace-option")).toHaveLength(2));
		const labels = screen.getAllByTestId("onboarding-tenancy-workspace-option").map((el) => el.textContent);
		expect(labels).toEqual(["default", "Team Workspace"]);
		expect(tenancy.selectTenancy).not.toHaveBeenCalled();

		fireEvent.click(screen.getAllByTestId("onboarding-tenancy-workspace-option")[1]!);
		await waitFor(() => expect(tenancy.selectTenancy).toHaveBeenCalledWith("o", "ws-team"));
	});

	it("ts-AC-9 fires dashboard_reached only after selected: true", async () => {
		const onboarding = mockOnboardingClient();
		const onComplete = vi.fn();
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
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
		render(<TenancyStep onboardingClient={onboarding} tenancyClient={tenancy} onComplete={onComplete} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-org-confirm-btn"));
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-workspace-option")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-workspace-option"));
		await waitFor(() => expect(onComplete).toHaveBeenCalled());
		expect(onboarding.sendEvent).toHaveBeenCalledWith("dashboard_reached");
		expect(onboarding.sendEvent).toHaveBeenCalledWith("tenancy_shown");
	});

	it("ts-AC-13 emits tenancy_selected with the bucketed org count and the single-org-confirm flag", async () => {
		const onboarding = mockOnboardingClient();
		const onComplete = vi.fn();
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
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
		render(<TenancyStep onboardingClient={onboarding} tenancyClient={tenancy} onComplete={onComplete} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-org-confirm-btn"));
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-workspace-option")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-workspace-option"));
		await waitFor(() => expect(onComplete).toHaveBeenCalled());
		expect(onboarding.sendEvent).toHaveBeenCalledWith("tenancy_selected", {
			orgCount: "single",
			singleOrgConfirm: "true",
		});
	});

	it("W-4 a persistently short-circuiting load (split-brain) lands on the bounded terminal state instead of looping", async () => {
		// Split-brain fault: the browser's tenancy read persistently says selected: true while the
		// gate keeps bouncing back to this step. Each bounce is a fresh page load (a fresh mount
		// sharing the tab's sessionStorage). Within the allowance the step auto-completes; past it
		// the step must STOP auto-navigating and render the terminal manual state.
		const splitBrainClient = (): TenancyClient => ({
			setupTenancy: vi.fn(async () => ({
				pending: false,
				selected: true,
				authenticated: true,
				org: { id: "o", name: "Org" },
				workspace: { id: "w", name: "WS" },
			})),
			listOrgs: vi.fn(),
			listWorkspaces: vi.fn(),
			selectTenancy: vi.fn(),
			createWorkspace: vi.fn(),
		});

		// Laps within the allowance: the auto short-circuit still navigates (the honest fast path).
		for (let lap = 0; lap < TENANCY_AUTO_COMPLETE_LIMIT; lap += 1) {
			const onComplete = vi.fn();
			render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={splitBrainClient()} onComplete={onComplete} />);
			await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
			cleanup();
		}

		// The lap past the bound: NO automatic navigation; the terminal split-brain state renders
		// with manual retry and continue affordances.
		const onComplete = vi.fn();
		render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={splitBrainClient()} onComplete={onComplete} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-split-brain")).toBeTruthy());
		expect(onComplete).not.toHaveBeenCalled();
		expect(screen.getByTestId("onboarding-tenancy-split-brain-retry")).toBeTruthy();
		expect(screen.getByTestId("onboarding-tenancy-split-brain-continue")).toBeTruthy();

		// The manual continue is an explicit operator action; it navigates exactly once.
		fireEvent.click(screen.getByTestId("onboarding-tenancy-split-brain-continue"));
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
	});

	it("W-4 a normal unselected load resets the loop counter (only consecutive short-circuits count)", async () => {
		// Seed the counter as if one auto short-circuit already happened...
		sessionStorage.setItem("hive.onboarding.tenancy.autoCompleteCount", String(TENANCY_AUTO_COMPLETE_LIMIT));
		// ...then load with selected: false. The live picker flow must clear the counter.
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
			listOrgs: vi.fn(async () => ({ orgs: [{ id: "o", name: "Org" }] })),
			listWorkspaces: vi.fn(),
			selectTenancy: vi.fn(),
			createWorkspace: vi.fn(),
		};
		render(<TenancyStep onboardingClient={mockOnboardingClient()} tenancyClient={tenancy} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		expect(sessionStorage.getItem("hive.onboarding.tenancy.autoCompleteCount")).toBeNull();
	});

	it("ts-AC-13 emits workspace_created after a created: true ack", async () => {
		const onboarding = mockOnboardingClient();
		const onComplete = vi.fn();
		const tenancy: TenancyClient = {
			setupTenancy: vi.fn(async () => ({ pending: true, selected: false, authenticated: true, org: null, workspace: null })),
			listOrgs: vi.fn(async () => ({ orgs: [{ id: "o", name: "Org" }] })),
			listWorkspaces: vi.fn(async () => ({ org: "o", workspaces: [], canCreate: true })),
			selectTenancy: vi.fn(async () => ({
				selected: true as const,
				org: { id: "o", name: "Org" },
				workspace: { id: "new-ws", name: "Fresh" },
				reminted: false,
			})),
			createWorkspace: vi.fn(async () => ({ created: true as const, workspace: { id: "new-ws", name: "Fresh" } })),
		};
		render(<TenancyStep onboardingClient={onboarding} tenancyClient={tenancy} onComplete={onComplete} />);
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-org-confirm")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-org-confirm-btn"));
		await waitFor(() => expect(screen.getByTestId("onboarding-tenancy-create-toggle")).toBeTruthy());
		fireEvent.click(screen.getByTestId("onboarding-tenancy-create-toggle"));
		fireEvent.change(screen.getByTestId("onboarding-tenancy-create-input"), { target: { value: "Fresh" } });
		fireEvent.click(screen.getByTestId("onboarding-tenancy-create-submit"));
		await waitFor(() => expect(onComplete).toHaveBeenCalled());
		expect(onboarding.sendEvent).toHaveBeenCalledWith("workspace_created");
		expect(tenancy.createWorkspace).toHaveBeenCalledWith("o", "Fresh");
	});
});
