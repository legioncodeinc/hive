// @vitest-environment jsdom
/**
 * PRD-011b W-1: render-level tests for the mounted `ActiveTenancyDisplay` component: the
 * hydrate-on-mount wiring (tv-AC-1), the honest degraded states at render (tv-AC-2/3), the
 * `refreshKey` re-hydrate on honeycomb recovery (tv-AC-4), and the persisted-switch re-hydrate
 * (tv-AC-5). The pure label helpers keep their own tests in `prd-011-tenancy.test.ts`.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ActiveTenancyDisplay } from "../../src/dashboard/web/active-tenancy-display.js";
import { ScopeSwitcherContext, type ScopeSwitcherValue, type SwitchFeedback } from "../../src/dashboard/web/scope-context.js";
import type { SetupTenancyResultWire, WireClient } from "../../src/dashboard/web/wire.js";

afterEach(() => cleanup());

function tenancyResult(overrides: Partial<SetupTenancyResultWire> = {}): SetupTenancyResultWire {
	return {
		pending: false,
		selected: true,
		authenticated: true,
		org: { id: "org-a", name: "Org A" },
		workspace: { id: "ws-1", name: "Workspace One" },
		unreachable: false,
		...overrides,
	};
}

function wireWith(result: SetupTenancyResultWire): WireClient {
	return { setupTenancy: vi.fn(async () => result) } as unknown as WireClient;
}

function switcherValue(switchFeedback: SwitchFeedback | null): ScopeSwitcherValue {
	return {
		orgs: [],
		workspaces: [],
		projects: [],
		projectsHydrated: false,
		loadingWorkspaces: false,
		switching: false,
		switchFeedback,
		retrySwitch: null,
		selectOrg: () => {},
		selectWorkspace: () => {},
		selectProject: () => {},
	};
}

describe("ActiveTenancyDisplay (mounted)", () => {
	it("tv-AC-1 hydrates on mount and renders the active org and workspace names", async () => {
		const wire = wireWith(tenancyResult());
		render(<ActiveTenancyDisplay wire={wire} />);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("Org A · Workspace One"));
		expect(screen.getByTestId("active-tenancy-display").getAttribute("data-tenancy-state")).toBe("ok");
		expect(wire.setupTenancy).toHaveBeenCalledTimes(1);
	});

	it("tv-AC-2 renders the explicit unavailable state when the read is unreachable, never a fabricated local · default", async () => {
		render(<ActiveTenancyDisplay wire={wireWith(tenancyResult({ unreachable: true }))} />);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("tenancy unavailable"));
		expect(screen.getByTestId("active-tenancy-display").getAttribute("data-tenancy-state")).toBe("unavailable");
	});

	it("tv-AC-3 renders 'not linked' and 'tenancy not selected' as distinct mounted states", async () => {
		const { unmount } = render(<ActiveTenancyDisplay wire={wireWith(tenancyResult({ authenticated: false, selected: false }))} />);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("not linked"));
		unmount();

		render(<ActiveTenancyDisplay wire={wireWith(tenancyResult({ authenticated: true, selected: false }))} />);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("tenancy not selected"));
	});

	it("tv-AC-4 re-hydrates when refreshKey increments (the shell's honeycomb down-to-up recovery)", async () => {
		let call = 0;
		const wire = {
			setupTenancy: vi.fn(async () => {
				call += 1;
				return call === 1 ? tenancyResult({ unreachable: true }) : tenancyResult();
			}),
		} as unknown as WireClient;

		const { rerender } = render(<ActiveTenancyDisplay wire={wire} refreshKey={0} />);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("tenancy unavailable"));

		rerender(<ActiveTenancyDisplay wire={wire} refreshKey={1} />);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("Org A · Workspace One"));
		expect(wire.setupTenancy).toHaveBeenCalledTimes(2);
	});

	it("tv-AC-5 re-hydrates when a persisted org/workspace switch acknowledges (pending switches do not re-hydrate)", async () => {
		let call = 0;
		const wire = {
			setupTenancy: vi.fn(async () => {
				call += 1;
				return call === 1
					? tenancyResult()
					: tenancyResult({ org: { id: "org-b", name: "Org B" }, workspace: { id: "ws-2", name: "Workspace Two" } });
			}),
		} as unknown as WireClient;

		const { rerender } = render(
			<ScopeSwitcherContext.Provider value={switcherValue(null)}>
				<ActiveTenancyDisplay wire={wire} />
			</ScopeSwitcherContext.Provider>,
		);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("Org A · Workspace One"));

		// A PENDING switch (re-mint in flight) must not re-hydrate yet.
		rerender(
			<ScopeSwitcherContext.Provider value={switcherValue({ kind: "persisted", message: "switching org…", pending: true })}>
				<ActiveTenancyDisplay wire={wire} />
			</ScopeSwitcherContext.Provider>,
		);
		expect(wire.setupTenancy).toHaveBeenCalledTimes(1);

		// The acknowledged persist re-hydrates and the readout reflects the new tenancy, no reload.
		rerender(
			<ScopeSwitcherContext.Provider value={switcherValue({ kind: "persisted", message: "switched to Org B" })}>
				<ActiveTenancyDisplay wire={wire} />
			</ScopeSwitcherContext.Provider>,
		);
		await waitFor(() => expect(screen.getByTestId("active-tenancy-display").textContent).toBe("Org B · Workspace Two"));
		expect(wire.setupTenancy).toHaveBeenCalledTimes(2);
	});

	it("renders the grandfathered hint when honeycomb reports confirmedBy: grandfathered", async () => {
		render(<ActiveTenancyDisplay wire={wireWith(tenancyResult({ confirmedBy: "grandfathered" }))} />);
		await waitFor(() =>
			expect(screen.getByTestId("active-tenancy-display").textContent).toBe("Org A · Workspace One (grandfathered)"),
		);
	});
});
