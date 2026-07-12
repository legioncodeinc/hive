// @vitest-environment jsdom
/**
 * ISS-002 — the Settings page "Memory graph" toggle row (vault-first `graph.enabled`).
 *
 * The row reuses the SAME Toggle/SettingRow idioms as the pollinating flag, persists through the
 * SAME `setSetting`/re-read contract, and — because the daemon defaults an UNSET `graph.enabled`
 * to FOLLOW the Memory switch — derives its unset display state from `/api/status`
 * `reasons.memory.enabled` (never a hardcoded guess). These cover the pure default-resolution
 * helper, the row render + hint copy, and the save wiring. All against a MOCKED wire.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { graphToggleOn, MemoryGraphSection } from "../../src/dashboard/web/pages/settings.js";
import { SETTING_KEY } from "../../src/dashboard/web/panels.js";
import { clearSwrCache } from "../../src/dashboard/web/use-swr.js";
import type { SettingValueWire, StatusProbe, WireClient } from "../../src/dashboard/web/wire.js";

/** Build a mock wire whose `/api/status` reports the given memory-switch state. */
function mockWire(memoryEnabled: boolean): WireClient {
	const status = vi.fn(
		async (): Promise<StatusProbe> => ({
			reasons: {
				storage: "reachable",
				embeddings: "on",
				schema: "ok",
				portkey: "ok",
				memory: { enabled: memoryEnabled, provider: "configured" },
			},
		}),
	);
	return { status } as unknown as WireClient;
}

function renderSection(
	settings: Readonly<Record<string, SettingValueWire>>,
	opts: { memoryEnabled?: boolean; onSave?: (key: string, value: SettingValueWire) => Promise<boolean> } = {},
): ReturnType<typeof vi.fn> {
	const onSave = vi.fn(opts.onSave ?? (async () => true));
	render(<MemoryGraphSection wire={mockWire(opts.memoryEnabled ?? false)} settings={settings} onSave={onSave} />);
	return onSave;
}

beforeEach(() => clearSwrCache());
afterEach(() => cleanup());

// ── The pure default-resolution helper ────────────────────────────────────────

describe("graphToggleOn (vault-first, memory-switch default)", () => {
	it("an explicit persisted value wins, boolean or string form", () => {
		expect(graphToggleOn(true, false)).toBe(true);
		expect(graphToggleOn("true", false)).toBe(true);
		expect(graphToggleOn(false, true)).toBe(false);
		expect(graphToggleOn("false", true)).toBe(false);
	});

	it("unset → follows the Memory switch (the daemon's documented default)", () => {
		expect(graphToggleOn(undefined, true)).toBe(true);
		expect(graphToggleOn(undefined, false)).toBe(false);
	});

	it("an unknown scalar → treated as unset (follows the Memory switch), never a throw", () => {
		expect(graphToggleOn("banana", true)).toBe(true);
		expect(graphToggleOn("banana", false)).toBe(false);
	});
});

// ── The row render + save wiring ──────────────────────────────────────────────

describe("MemoryGraphSection (ISS-002)", () => {
	it("renders the row with the mandated hint copy", async () => {
		renderSection({});
		expect(screen.getByTestId("memory-graph-section")).toBeTruthy();
		expect(screen.getByText("follows the Memory switch by default; applies live")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "memory graph" })).toBeTruthy();
	});

	it("unset graph.enabled → the toggle reflects the Memory switch state", async () => {
		renderSection({}, { memoryEnabled: true });
		const toggle = screen.getByRole("switch", { name: "memory graph" });
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
	});

	it("explicit graph.enabled=false → off even while the Memory switch is on; a flip saves true", async () => {
		const onSave = renderSection({ [SETTING_KEY.graphEnabled]: false }, { memoryEnabled: true });
		const toggle = screen.getByRole("switch", { name: "memory graph" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(toggle);
		await waitFor(() => expect(onSave).toHaveBeenCalledWith(SETTING_KEY.graphEnabled, true));
	});

	it("explicit graph.enabled=true → on; a flip saves false through the settings save path", async () => {
		const onSave = renderSection({ [SETTING_KEY.graphEnabled]: true });
		const toggle = screen.getByRole("switch", { name: "memory graph" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle);
		await waitFor(() => expect(onSave).toHaveBeenCalledWith(SETTING_KEY.graphEnabled, false));
	});

	it("the string form 'true' (vault JSON-scalar round-trip) reads as on", () => {
		renderSection({ [SETTING_KEY.graphEnabled]: "true" });
		expect(screen.getByRole("switch", { name: "memory graph" }).getAttribute("aria-checked")).toBe("true");
	});
});
