// @vitest-environment jsdom
/**
 * PRD-006d: the dashboard harness-connect card. Covers d-AC-2 (a row per harness showing
 * agent-present + plugin-enabled + last reconcile outcome), d-AC-3 (Repair re-runs the setup and
 * the shown state updates from a re-read), and d-AC-5 (a repair that cannot complete shows a clear
 * message and never blocks; a fail-soft empty read self-hides the card).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HarnessConnectCard } from "../../src/dashboard/web/harness-connect-card.js";
import { clearSwrCache } from "../../src/dashboard/web/use-swr.js";
import type { HarnessConnectionStateWire, HarnessRepairResultWire, WireClient } from "../../src/dashboard/web/wire.js";

function fakeWire(overrides: Partial<WireClient>): WireClient {
	return {
		harnessConnectionStatus: vi.fn(async (): Promise<HarnessConnectionStateWire[]> => []),
		repairHarness: vi.fn(async (): Promise<HarnessRepairResultWire | null> => null),
		...overrides,
	} as unknown as WireClient;
}

afterEach(() => {
	cleanup();
	clearSwrCache();
});

describe("HarnessConnectCard", () => {
	it("d-AC-2: renders one row per harness with agent-present + plugin-enabled + last outcome", async () => {
		const wire = fakeWire({
			harnessConnectionStatus: vi.fn(async () => [
				{ harness: "claude-code", agentPresent: true, pluginEnabled: true, connected: true, lastOutcome: "already-enabled" },
				{ harness: "codex", agentPresent: true, pluginEnabled: false, connected: false },
			]),
		});

		render(<HarnessConnectCard wire={wire} pollMs={0} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-card")).toBeTruthy());
		expect(screen.getByTestId("harness-connect-row-claude-code")).toBeTruthy();
		expect(screen.getByTestId("harness-connect-row-codex")).toBeTruthy();
		expect(screen.getByTestId("harness-connect-row-claude-code").textContent).toContain("already-enabled");
	});

	it("d-AC-5: self-hides when the (fail-soft) read returns no harnesses", async () => {
		const harnessConnectionStatus = vi.fn(async () => [] as HarnessConnectionStateWire[]);
		const wire = fakeWire({ harnessConnectionStatus });

		render(<HarnessConnectCard wire={wire} pollMs={0} />);

		await waitFor(() => expect(harnessConnectionStatus).toHaveBeenCalled());
		expect(screen.queryByTestId("harness-connect-card")).toBeNull();
	});

	it("d-AC-3: Repair re-runs the setup and the shown state updates from a re-read", async () => {
		let rows: HarnessConnectionStateWire[] = [{ harness: "claude-code", agentPresent: true, pluginEnabled: false, connected: false }];
		const harnessConnectionStatus = vi.fn(async () => rows);
		const repairHarness = vi.fn(async (): Promise<HarnessRepairResultWire> => {
			rows = [{ harness: "claude-code", agentPresent: true, pluginEnabled: true, connected: true, lastOutcome: "wired" }];
			return { harness: "claude-code", status: "connected", connected: true };
		});
		const wire = fakeWire({ harnessConnectionStatus, repairHarness });

		render(<HarnessConnectCard wire={wire} pollMs={0} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-repair-claude-code")).toBeTruthy());
		fireEvent.click(screen.getByTestId("harness-connect-repair-claude-code"));

		await waitFor(() => expect(screen.getByTestId("harness-connect-repair-msg-claude-code").textContent).toContain("Repaired: connected"));
		expect(repairHarness).toHaveBeenCalledWith("claude-code");
		// The re-read reflects the persisted state (plugin now enabled).
		await waitFor(() => expect(screen.getByTestId("harness-connect-row-claude-code").textContent).toContain("wired"));
	});

	it("d-AC-3: while a repair is in flight, every repair button is disabled (no silent no-op on a second harness)", async () => {
		let release: (r: HarnessRepairResultWire) => void = () => {};
		const wire = fakeWire({
			harnessConnectionStatus: vi.fn(async () => [
				{ harness: "claude-code", agentPresent: true, pluginEnabled: false, connected: false },
				{ harness: "codex", agentPresent: true, pluginEnabled: false, connected: false },
			]),
			repairHarness: vi.fn(
				() =>
					new Promise<HarnessRepairResultWire>((resolve) => {
						release = resolve;
					}),
			),
		});

		render(<HarnessConnectCard wire={wire} pollMs={0} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-repair-claude-code")).toBeTruthy());
		fireEvent.click(screen.getByTestId("harness-connect-repair-claude-code"));

		// The other harness's button is disabled while the first repair is in flight, so a click
		// cannot silently no-op against the single-in-flight guard.
		await waitFor(() => expect((screen.getByTestId("harness-connect-repair-codex") as HTMLButtonElement).disabled).toBe(true));
		expect((screen.getByTestId("harness-connect-repair-claude-code") as HTMLButtonElement).disabled).toBe(true);

		release({ harness: "claude-code", status: "connected", connected: true });
		await waitFor(() => expect((screen.getByTestId("harness-connect-repair-codex") as HTMLButtonElement).disabled).toBe(false));
	});

	it("d-AC-2: the eyebrow reflects how many harnesses are connected, not the total row count", async () => {
		const wire = fakeWire({
			harnessConnectionStatus: vi.fn(async () => [
				{ harness: "claude-code", agentPresent: true, pluginEnabled: true, connected: true },
				{ harness: "codex", agentPresent: true, pluginEnabled: false, connected: false },
			]),
		});

		render(<HarnessConnectCard wire={wire} pollMs={0} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-card")).toBeTruthy());
		expect(screen.getByTestId("harness-connect-card").textContent).toContain("1 of 2 connected");
	});

	it("d-AC-5: a repair that cannot complete shows a clear message and never blocks", async () => {
		const wire = fakeWire({
			harnessConnectionStatus: vi.fn(async () => [{ harness: "claude-code", agentPresent: false, pluginEnabled: false, connected: false }]),
			repairHarness: vi.fn(async () => null),
		});

		render(<HarnessConnectCard wire={wire} pollMs={0} />);

		await waitFor(() => expect(screen.getByTestId("harness-connect-repair-claude-code")).toBeTruthy());
		fireEvent.click(screen.getByTestId("harness-connect-repair-claude-code"));

		await waitFor(() => expect(screen.getByTestId("harness-connect-repair-msg-claude-code").textContent).toContain("Could not reach honeycomb"));
		// The card is still present and interactive (never blocks the dashboard).
		expect(screen.getByTestId("harness-connect-card")).toBeTruthy();
		expect((screen.getByTestId("harness-connect-repair-claude-code") as HTMLButtonElement).disabled).toBe(false);
	});
});
