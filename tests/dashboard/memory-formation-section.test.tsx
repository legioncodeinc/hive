// @vitest-environment jsdom
/**
 * The PROMINENT, provider-gated Memory Formation control on the Settings page. Mirrors the embeddings
 * toggle's data path: it reads `wire.health()` `reasons.memory = { enabled, provider }` and flips it
 * through `wire.setMemory(...)` (the `POST /api/actions/memory` sibling of the embeddings action). These
 * exercise the two states (unconfigured prompt vs configured enable control), the toggle payload, and
 * the state reflecting `reasons.memory.enabled` — all against a MOCKED wire (no live daemon).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryFormationSection } from "../../src/dashboard/web/pages/settings.js";
import type { HealthProbe, WireClient } from "../../src/dashboard/web/wire.js";

/** Build a mock wire whose `/health` reports the given memory reason (or none), tracking setMemory calls. */
function mockWire(
	memory: { enabled: boolean; provider: "configured" | "unconfigured" } | undefined,
	opts: { setMemoryOk?: boolean } = {},
): { wire: WireClient; setMemory: ReturnType<typeof vi.fn>; restartDaemon: ReturnType<typeof vi.fn> } {
	const setMemory = vi.fn(async () => opts.setMemoryOk ?? true);
	const restartDaemon = vi.fn(async () => true);
	const health = vi.fn(
		async (): Promise<HealthProbe> => ({
			up: true,
			reasons: {
				storage: "reachable",
				embeddings: "on",
				schema: "ok",
				portkey: "ok",
				memory,
			},
		}),
	);
	const wire = { health, setMemory, restartDaemon } as unknown as WireClient;
	return { wire, setMemory, restartDaemon };
}

afterEach(() => cleanup());

describe("MemoryFormationSection", () => {
	it("provider unconfigured → shows the explanatory prompt and HIDES the enable action", async () => {
		const { wire } = mockWire({ enabled: false, provider: "unconfigured" });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-unconfigured")).toBeTruthy());
		// The "configure a provider" copy is present…
		expect(screen.getByTestId("memory-unconfigured").textContent).toContain("Configure a model provider");
		// …and the enable control is NOT rendered (nothing to enable yet).
		expect(screen.queryByTestId("memory-toggle")).toBeNull();
	});

	it("provider configured + disabled → offers 'Turn on' and calls setMemory(true) with the right intent", async () => {
		const { wire, setMemory } = mockWire({ enabled: false, provider: "configured" });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-configured")).toBeTruthy());
		const toggle = screen.getByTestId("memory-toggle");
		expect(toggle.textContent).toBe("Turn on");

		fireEvent.click(toggle);
		await waitFor(() => expect(setMemory).toHaveBeenCalledWith(true));
	});

	it("provider configured + enabled → reflects reasons.memory.enabled ('on' badge + 'Turn off')", async () => {
		const { wire, setMemory } = mockWire({ enabled: true, provider: "configured" });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-configured")).toBeTruthy());
		expect(screen.getByTestId("memory-toggle").textContent).toBe("Turn off");
		// Toggling an enabled feature requests OFF.
		fireEvent.click(screen.getByTestId("memory-toggle"));
		await waitFor(() => expect(setMemory).toHaveBeenCalledWith(false));
	});

	it("configured → surfaces the applies-on-restart honesty and a restart affordance", async () => {
		const { wire, restartDaemon } = mockWire({ enabled: true, provider: "configured" });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-restart-note")).toBeTruthy());
		expect(screen.getByTestId("memory-restart-note").textContent).toContain("next daemon restart");

		fireEvent.click(screen.getByTestId("memory-restart-button"));
		await waitFor(() => expect(restartDaemon).toHaveBeenCalledTimes(1));
	});

	it("a missing memory block (pre-memory daemon) degrades to the unconfigured prompt (fail-closed)", async () => {
		const { wire } = mockWire(undefined);
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-unconfigured")).toBeTruthy());
		expect(screen.queryByTestId("memory-toggle")).toBeNull();
	});
});
