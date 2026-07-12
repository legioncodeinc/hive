import { describe, expect, it } from "vitest";

import { HealthReasonsSchema } from "../../src/dashboard/web/wire.js";

// Wave-3 QA W-1/W-2 (fix/health-surface-honesty): the daemon's health surface grew — portkey gained
// `no_model` + a sibling `portkeyUnreachableStatus` (honeycomb #300), the coarse `embeddings` now
// mirrors the full live enum incl. `suspect` (honeycomb #301), and a `memoryFormation` counters block
// rides `reasons` (#300, ISS-005). This is the parse matrix:
//   1. an OLD daemon payload parses to exactly the pre-Wave-3 behaviour (back-compat);
//   2. every NEW state parses verbatim;
//   3. garbage/unknown values fold to a DISTINCT non-healthy reading — unknown embeddings is NEVER
//      "on" and unknown portkey is NEVER a healthy-looking "off"/"ok" (the false-healthy readings
//      ISS-005/ISS-007 set out to kill).

/** A canonical pre-Wave-3 (old-daemon) reasons payload — only the legacy fields and values. */
const OLD_DAEMON = { storage: "reachable", embeddings: "on", schema: "ok", portkey: "ok" } as const;

describe("HealthReasonsSchema — old daemon back-compat (must parse to today's behaviour)", () => {
	it("parses the legacy payload verbatim; every new field is absent/undefined", () => {
		const parsed = HealthReasonsSchema.parse(OLD_DAEMON);
		expect(parsed.storage).toBe("reachable");
		expect(parsed.embeddings).toBe("on");
		expect(parsed.embeddingsState).toBeUndefined();
		expect(parsed.schema).toBe("ok");
		expect(parsed.portkey).toBe("ok");
		expect(parsed.portkeyUnreachableStatus).toBeUndefined();
		expect(parsed.memoryFormation).toBeUndefined();
	});

	it("a pre-063b daemon that omits `portkey` entirely still reads 'off' (not in force — the legacy default)", () => {
		const parsed = HealthReasonsSchema.parse({ storage: "reachable", embeddings: "on", schema: "ok" });
		expect(parsed.portkey).toBe("off");
	});

	it("legacy embeddings 'off' still parses verbatim", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, embeddings: "off" });
		expect(parsed.embeddings).toBe("off");
	});
});

describe("HealthReasonsSchema — the new daemon states parse verbatim", () => {
	it("coarse embeddings carries the full live enum (honeycomb #301), including suspect", () => {
		for (const state of ["on", "off", "warming", "suspect", "failed"] as const) {
			expect(HealthReasonsSchema.parse({ ...OLD_DAEMON, embeddings: state }).embeddings).toBe(state);
		}
	});

	it("embeddingsState accepts suspect (the wedge-suspicion window is no longer invisible)", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, embeddingsState: "suspect" });
		expect(parsed.embeddingsState).toBe("suspect");
	});

	it("portkey accepts no_model (gateway enabled, no model set — honeycomb #300 / ISS-005)", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, portkey: "no_model" });
		expect(parsed.portkey).toBe("no_model");
	});

	it("portkeyUnreachableStatus rides beside unreachable (so the chip can read unreachable(401))", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, portkey: "unreachable", portkeyUnreachableStatus: 401 });
		expect(parsed.portkey).toBe("unreachable");
		expect(parsed.portkeyUnreachableStatus).toBe(401);
	});

	it("memoryFormation parses the full counters block (honeycomb #300, ISS-005 visibility)", () => {
		const mf = {
			committedSinceBoot: 12,
			lastCommittedAt: "2026-07-12T00:00:00.000Z",
			lastAction: "inserted",
			extractionErrorsSinceBoot: 373,
			lastExtractionError: "portkey: 401 unauthorized",
			lastExtractionErrorAt: "2026-07-12T00:01:00.000Z",
		};
		expect(HealthReasonsSchema.parse({ ...OLD_DAEMON, memoryFormation: mf }).memoryFormation).toEqual(mf);
	});

	it("memoryFormation parses the minimal block (counters only — the pre-first-commit shape)", () => {
		const parsed = HealthReasonsSchema.parse({
			...OLD_DAEMON,
			memoryFormation: { committedSinceBoot: 0, extractionErrorsSinceBoot: 0 },
		});
		expect(parsed.memoryFormation).toEqual({ committedSinceBoot: 0, extractionErrorsSinceBoot: 0 });
	});
});

describe("HealthReasonsSchema — garbage/unknown values fold to NON-healthy readings", () => {
	it("an unknown coarse embeddings value parses to 'unknown' — NEVER 'on' (W-2)", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, embeddings: "quantum" });
		expect(parsed.embeddings).toBe("unknown");
		expect(parsed.embeddings).not.toBe("on");
		// The rest of the block survives (fail-soft, field-by-field).
		expect(parsed.storage).toBe("reachable");
	});

	it("an unknown portkey value parses to 'unknown' — NEVER the healthy-looking 'off'/'ok' (W-1)", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, portkey: "hyperspace" });
		expect(parsed.portkey).toBe("unknown");
		expect(["off", "ok"]).not.toContain(parsed.portkey);
	});

	it("an unknown embeddingsState degrades to undefined (falls back to the coarse field) without losing the block", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, embeddings: "suspect", embeddingsState: "bogus" });
		expect(parsed.embeddingsState).toBeUndefined();
		expect(parsed.embeddings).toBe("suspect");
	});

	it("garbage portkeyUnreachableStatus (negative / non-numeric) degrades to undefined (plain 'unreachable')", () => {
		expect(HealthReasonsSchema.parse({ ...OLD_DAEMON, portkeyUnreachableStatus: -1 }).portkeyUnreachableStatus).toBeUndefined();
		expect(HealthReasonsSchema.parse({ ...OLD_DAEMON, portkeyUnreachableStatus: "401" }).portkeyUnreachableStatus).toBeUndefined();
	});

	it("a malformed memoryFormation block degrades to undefined without losing the rest of the reasons", () => {
		const parsed = HealthReasonsSchema.parse({ ...OLD_DAEMON, memoryFormation: "corrupt" });
		expect(parsed.memoryFormation).toBeUndefined();
		expect(parsed.embeddings).toBe("on");
	});

	it("garbage inner memoryFormation counters degrade to safe zeros/absence, keeping the block alive", () => {
		const parsed = HealthReasonsSchema.parse({
			...OLD_DAEMON,
			memoryFormation: { committedSinceBoot: -5, extractionErrorsSinceBoot: "many", lastExtractionError: 42 },
		});
		expect(parsed.memoryFormation).toEqual({ committedSinceBoot: 0, extractionErrorsSinceBoot: 0 });
	});
});
