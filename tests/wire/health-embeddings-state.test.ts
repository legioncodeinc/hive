import { describe, expect, it } from "vitest";

import { HealthReasonsSchema } from "../../src/dashboard/web/wire.js";

// PRD-025 honesty: the `/health` `reasons` block gained an ADDITIVE `embeddingsState`
// (`off | warming | on | failed`) alongside the coarse `embeddings` field, so the dashboard can show
// real feedback (model downloading vs actually working vs could-not-load). These assert the wire
// schema parses the new field, keeps its fail-soft posture, and stays back-compatible.
describe("HealthReasonsSchema — embeddingsState (PRD-025 honesty)", () => {
	const base = { storage: "reachable", embeddings: "on", schema: "ok", portkey: "ok" } as const;

	it("parses each honest state verbatim", () => {
		for (const state of ["off", "warming", "on", "failed"] as const) {
			const parsed = HealthReasonsSchema.parse({ ...base, embeddingsState: state });
			expect(parsed.embeddingsState).toBe(state);
		}
	});

	it("is optional — a pre-honesty daemon (no embeddingsState) still parses, field is undefined", () => {
		const parsed = HealthReasonsSchema.parse(base);
		expect(parsed.embeddingsState).toBeUndefined();
		// The coarse field is untouched (back-compat), so the UI can fall back to it.
		expect(parsed.embeddings).toBe("on");
	});

	it("an unknown/garbage embeddingsState drops to undefined WITHOUT losing the rest of the block", () => {
		// `.catch(undefined)` (like every other reason's `.catch`) means a bad value degrades JUST this
		// field to undefined — the whole `reasons` block survives, so the health strip + other subsystems
		// still render and the embeddings UI falls back to the coarse `embeddings` field.
		const parsed = HealthReasonsSchema.parse({ ...base, embeddingsState: "bogus" });
		expect(parsed.embeddingsState).toBeUndefined();
		expect(parsed.storage).toBe("reachable");
		expect(parsed.embeddings).toBe("on");
		expect(parsed.portkey).toBe("ok");
	});
});
