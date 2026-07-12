// @vitest-environment jsdom
/**
 * The PROMINENT, provider-gated Memory Formation control on the Settings page. Mirrors the embeddings
 * toggle's data path: it reads the memory reason from `wire.status()` (honeycomb's `/api/status`
 * `reasons.memory = { enabled, provider }`) and flips it through `wire.setMemory(...)` (the
 * `POST /api/actions/memory` sibling of the embeddings action). The reasons come from `/api/status`
 * (NOT hive's own reasons-less `/health`), which is the fix for the fail-close bug: with a provider
 * configured the control shows the enable state instead of a false "provider needed". These exercise
 * the two states (unconfigured prompt vs configured enable control), the toggle payload, the state
 * reflecting `reasons.memory.enabled`, and the fail-closed default when `/api/status` omits reasons —
 * all against a MOCKED wire (no live daemon).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryFormationSection } from "../../src/dashboard/web/pages/settings.js";
import type { MemoryToggleAckWire, StatusProbe, WireClient } from "../../src/dashboard/web/wire.js";

/** The live-reload daemon's honest ack (honeycomb #304): persisted AND actuated live. */
const ACK_LIVE: MemoryToggleAckWire = { ok: true, enabled: true, persisted: true, appliedLive: true, appliesOnRestart: false };
/** An OLD (persist-only) daemon's ack: saved, applies on the next restart (`appliedLive` catch-defaulted false). */
const ACK_OLD_DAEMON: MemoryToggleAckWire = { ok: true, enabled: true, persisted: true, appliedLive: false, appliesOnRestart: true };
/** A daemon that answered but did NOT persist (vault unavailable / rejected): must never render success. */
const ACK_NOT_PERSISTED: MemoryToggleAckWire = { ok: true, enabled: true, persisted: false, appliedLive: false, appliesOnRestart: true };

/**
 * Build a mock wire whose `/api/status` reports the given memory reason (or none), tracking setMemory
 * calls. Also stubs `health()` returning a reasons-LESS probe (mirroring hive's own liveness `/health`)
 * to prove the control reads memory state from `status()` and NOT from `health()`.
 */
function mockWire(
	memory: { enabled: boolean; provider: "configured" | "unconfigured" } | undefined,
	opts: { ack?: MemoryToggleAckWire | null } = {},
): { wire: WireClient; setMemory: ReturnType<typeof vi.fn>; restartDaemon: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; health: ReturnType<typeof vi.fn> } {
	const setMemory = vi.fn(async () => (opts.ack === undefined ? ACK_LIVE : opts.ack));
	const restartDaemon = vi.fn(async () => true);
	// hive's own `/health` is liveness only — NO reasons. If the control read this it would fail-close.
	const health = vi.fn(async () => ({ up: true, reasons: null }));
	const status = vi.fn(
		async (): Promise<StatusProbe> => ({
			reasons: {
				storage: "reachable",
				embeddings: "on",
				schema: "ok",
				portkey: "ok",
				memory,
			},
		}),
	);
	const wire = { health, status, setMemory, restartDaemon } as unknown as WireClient;
	return { wire, setMemory, restartDaemon, status, health };
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

	// ── the W-3 toggle-ack honesty matrix: the note is derived from the daemon's ACK, never hardcoded ──

	it("before any toggle → NO narrative note (the page cannot know whether the daemon applies changes live)", async () => {
		const { wire } = mockWire({ enabled: true, provider: "configured" });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-configured")).toBeTruthy());
		expect(screen.queryByTestId("memory-restart-note")).toBeNull();
		expect(screen.queryByTestId("memory-applied-live")).toBeNull();
		expect(screen.queryByTestId("memory-save-failed")).toBeNull();
	});

	it("appliedLive ack (live-reload daemon, #304) → 'applied live' success copy and NO restart nag", async () => {
		const { wire } = mockWire({ enabled: false, provider: "configured" }, { ack: ACK_LIVE });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-toggle")).toBeTruthy());
		fireEvent.click(screen.getByTestId("memory-toggle"));

		await waitFor(() => expect(screen.getByTestId("memory-applied-live")).toBeTruthy());
		expect(screen.getByTestId("memory-applied-live").textContent).toContain("applied live");
		// The restart nag is SUPPRESSED — no note, no button (the change is already in force).
		expect(screen.queryByTestId("memory-restart-note")).toBeNull();
		expect(screen.queryByTestId("memory-restart-button")).toBeNull();
		expect(screen.queryByTestId("memory-save-failed")).toBeNull();
	});

	it("persisted-only ack (OLD daemon, appliedLive=false) → the honest restart copy + a working restart affordance", async () => {
		const { wire, restartDaemon } = mockWire({ enabled: false, provider: "configured" }, { ack: ACK_OLD_DAEMON });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-toggle")).toBeTruthy());
		fireEvent.click(screen.getByTestId("memory-toggle"));

		await waitFor(() => expect(screen.getByTestId("memory-restart-note")).toBeTruthy());
		expect(screen.getByTestId("memory-restart-note").textContent).toContain("next daemon restart");
		expect(screen.queryByTestId("memory-applied-live")).toBeNull();

		fireEvent.click(screen.getByTestId("memory-restart-button"));
		await waitFor(() => expect(restartDaemon).toHaveBeenCalledTimes(1));
	});

	it("unpersisted ack (daemon rejected / vault unavailable) → honest FAILURE copy, never a success state", async () => {
		const { wire } = mockWire({ enabled: false, provider: "configured" }, { ack: ACK_NOT_PERSISTED });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-toggle")).toBeTruthy());
		fireEvent.click(screen.getByTestId("memory-toggle"));

		await waitFor(() => expect(screen.getByTestId("memory-save-failed")).toBeTruthy());
		expect(screen.getByTestId("memory-save-failed").textContent).toContain("Not saved");
		expect(screen.queryByTestId("memory-applied-live")).toBeNull();
		expect(screen.queryByTestId("memory-restart-note")).toBeNull();
	});

	it("a null ack (non-2xx / network / malformed body) → the same honest FAILURE copy", async () => {
		const { wire } = mockWire({ enabled: false, provider: "configured" }, { ack: null });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-toggle")).toBeTruthy());
		fireEvent.click(screen.getByTestId("memory-toggle"));

		await waitFor(() => expect(screen.getByTestId("memory-save-failed")).toBeTruthy());
		expect(screen.queryByTestId("memory-applied-live")).toBeNull();
	});

	it("a missing memory block (pre-memory daemon) degrades to the unconfigured prompt (fail-closed)", async () => {
		const { wire } = mockWire(undefined);
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-unconfigured")).toBeTruthy());
		expect(screen.queryByTestId("memory-toggle")).toBeNull();
	});

	it("reads the memory reason from /api/status (wire.status), NOT the reasons-less /health (wire.health)", async () => {
		const { wire, status, health } = mockWire({ enabled: false, provider: "configured" });
		render(<MemoryFormationSection wire={wire} />);

		// With a provider configured on /api/status, the control shows the CONFIGURED enable state —
		// the exact bug fix (reading /health, which has no reasons, would fail-close to "provider needed").
		await waitFor(() => expect(screen.getByTestId("memory-configured")).toBeTruthy());
		expect(status).toHaveBeenCalled();
		expect(health).not.toHaveBeenCalled();
	});

	it("a reasons-less /api/status body (absent reasons) fail-closes to the unconfigured prompt", async () => {
		const { wire } = mockWire({ enabled: true, provider: "configured" });
		// Override status to return NO reasons (the mode-gated / pre-#248 body) — must fail-closed.
		(wire.status as ReturnType<typeof vi.fn>).mockResolvedValue({ reasons: null });
		render(<MemoryFormationSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("memory-unconfigured")).toBeTruthy());
		expect(screen.queryByTestId("memory-toggle")).toBeNull();
	});
});
