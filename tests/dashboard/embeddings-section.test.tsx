// @vitest-environment jsdom
/**
 * The Embeddings (semantic recall) toggle on the Settings page. It reads the honest embeddings state
 * from `wire.status()` (honeycomb's `/api/status` `reasons.embeddingsState` / coarse `reasons.embeddings`)
 * and flips it through `wire.setEmbeddings(...)`. The reasons come from `/api/status` (NOT hive's own
 * reasons-less `/health`), which is the fix for the fail-close bug: with embeddings ON the badge shows
 * "on" instead of a false "off". These exercise the on/off/absent states and the toggle payload — all
 * against a MOCKED wire (no live daemon).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EmbeddingsSection } from "../../src/dashboard/web/pages/settings.js";
import type { HealthReasonsWire, StatusProbe, WireClient } from "../../src/dashboard/web/wire.js";

/**
 * Build a mock wire whose `/api/status` reports the given embeddings reasons (or none), tracking
 * setEmbeddings calls. Stubs `health()` returning a reasons-LESS probe (mirroring hive's own liveness
 * `/health`) to prove the control reads embeddings state from `status()` and NOT from `health()`.
 */
function mockWire(
	reasons: Pick<HealthReasonsWire, "embeddings" | "embeddingsState"> | null,
	opts: { setEmbeddingsOk?: boolean } = {},
): { wire: WireClient; setEmbeddings: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; health: ReturnType<typeof vi.fn> } {
	const setEmbeddings = vi.fn(async () => opts.setEmbeddingsOk ?? true);
	const health = vi.fn(async () => ({ up: true, reasons: null }));
	const status = vi.fn(
		async (): Promise<StatusProbe> => ({
			reasons: reasons === null ? null : { storage: "reachable", schema: "ok", portkey: "ok", ...reasons },
		}),
	);
	const wire = { health, status, setEmbeddings } as unknown as WireClient;
	return { wire, setEmbeddings, status, health };
}

afterEach(() => cleanup());

describe("EmbeddingsSection", () => {
	it("reads embeddings state from /api/status (wire.status), NOT the reasons-less /health (wire.health)", async () => {
		const { wire, status, health } = mockWire({ embeddings: "on", embeddingsState: "on" });
		render(<EmbeddingsSection wire={wire} />);

		// With embeddings ON on /api/status, the badge shows "on" + the button offers "Turn off" — the
		// exact bug fix (reading /health, which has no reasons, would fail-close to "off").
		await waitFor(() => expect(screen.getByTestId("embeddings-toggle").textContent).toBe("Turn off"));
		expect(status).toHaveBeenCalled();
		expect(health).not.toHaveBeenCalled();
	});

	it("embeddings off → offers 'Turn on' and calls setEmbeddings(true)", async () => {
		const { wire, setEmbeddings } = mockWire({ embeddings: "off", embeddingsState: "off" });
		render(<EmbeddingsSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("embeddings-toggle").textContent).toBe("Turn on"));
		fireEvent.click(screen.getByTestId("embeddings-toggle"));
		await waitFor(() => expect(setEmbeddings).toHaveBeenCalledWith(true));
	});

	it("falls back to the coarse reasons.embeddings when embeddingsState is absent (pre-honesty daemon)", async () => {
		const { wire } = mockWire({ embeddings: "on" });
		render(<EmbeddingsSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("embeddings-toggle").textContent).toBe("Turn off"));
	});

	it("a reasons-less /api/status body (absent reasons) fail-closes to off", async () => {
		const { wire } = mockWire(null);
		render(<EmbeddingsSection wire={wire} />);

		await waitFor(() => expect(screen.getByTestId("embeddings-toggle").textContent).toBe("Turn on"));
	});
});
