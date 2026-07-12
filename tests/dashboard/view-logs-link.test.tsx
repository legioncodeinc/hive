// @vitest-environment jsdom
/**
 * ISS-009: LiveLog tails were pruned from the dashboard/harnesses/sync/health pages — the compact
 * `ViewLogsLink` affordance replaces them, navigating client-side to the Logs page (`/logs`).
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ViewLogsLink } from "../../src/dashboard/web/panels.js";
import { LOGS_ROUTE } from "../../src/dashboard/web/registry.js";

afterEach(() => {
	cleanup();
});

describe("ViewLogsLink (ISS-009)", () => {
	it("navigates to the Logs route via the shared path router (client-side, no reload)", () => {
		window.history.replaceState(null, "", "/");
		render(<ViewLogsLink />);

		act(() => {
			fireEvent.click(screen.getByTestId("view-logs-link"));
		});

		expect(window.location.pathname).toBe(LOGS_ROUTE);
	});
});
