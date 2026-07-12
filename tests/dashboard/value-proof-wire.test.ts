/**
 * ISS-010 / ISS-011 — wire-schema BACK-COMPAT for the value-proof additions.
 *
 * The honeycomb daemon additively gains (1) `injectedTokens` on `/api/diagnostics/kpis` and
 * (2) `partial` + `missingInputs` on the ROI view's net section. OLD daemons never send the new
 * fields — every addition must degrade via zod `.catch`/defaults, never a throw into React:
 *   - an old payload WITHOUT the new fields parses, with the safe defaults (0 / false / []);
 *   - a malformed value for a new field collapses to the same safe default;
 *   - a new-daemon payload carries the fields through verbatim.
 */

import {
	EMPTY_KPIS,
	KpisSchema,
	RoiNetSectionSchema,
	RoiViewSchema,
} from "../../src/dashboard/web/wire.js";
import { EMPTY_ROI_VIEW } from "../../src/dashboard/contracts.js";

// ── ISS-010: `injectedTokens` on the KPIs payload ────────────────────────────

describe("KpisSchema injectedTokens back-compat (ISS-010)", () => {
	it("parses an OLD daemon payload without injectedTokens to 0 (never a throw)", () => {
		const old = { memoryCount: 12, sessionCount: 4, turnCount: 4, estimatedSavings: 48210, teamSkillCount: 2 };
		const parsed = KpisSchema.parse(old);
		expect(parsed.injectedTokens).toBe(0);
		// The pre-existing fields survive untouched.
		expect(parsed.estimatedSavings).toBe(48210);
		expect(parsed.memoryCount).toBe(12);
	});

	it("collapses a malformed injectedTokens value to 0", () => {
		const malformed = { memoryCount: 1, sessionCount: 1, turnCount: 1, estimatedSavings: 10, teamSkillCount: 0, injectedTokens: "lots" };
		expect(KpisSchema.parse(malformed).injectedTokens).toBe(0);
	});

	it("carries a NEW daemon's live injectedTokens count through verbatim", () => {
		const live = { memoryCount: 1, sessionCount: 1, turnCount: 1, estimatedSavings: 10, teamSkillCount: 0, injectedTokens: 12345 };
		expect(KpisSchema.parse(live).injectedTokens).toBe(12345);
	});

	it("EMPTY_KPIS zeroes injectedTokens (the pre-first-load tile reads 0, not undefined)", () => {
		expect(EMPTY_KPIS.injectedTokens).toBe(0);
	});
});

// ── ISS-011: `partial` + `missingInputs` on the net section ──────────────────

/** An OLD daemon's net section — exactly the pre-ISS-011 shape (no partial/missingInputs). */
const OLD_NET = { status: "ok", computed: true, netCents: 12034, modeled: true, costBasis: "measured" } as const;

describe("RoiNetSectionSchema partial/missingInputs back-compat (ISS-011)", () => {
	it("parses an OLD daemon net (no new fields) to partial:false + missingInputs:[]", () => {
		const parsed = RoiNetSectionSchema.parse(OLD_NET);
		expect(parsed.partial).toBe(false);
		expect(parsed.missingInputs).toEqual([]);
		// The pre-existing net contract is untouched.
		expect(parsed.computed).toBe(true);
		expect(parsed.netCents).toBe(12034);
	});

	it("collapses malformed partial/missingInputs values to the safe defaults", () => {
		const malformed = { ...OLD_NET, partial: "yes", missingInputs: "infra" };
		const parsed = RoiNetSectionSchema.parse(malformed);
		expect(parsed.partial).toBe(false);
		expect(parsed.missingInputs).toEqual([]);
	});

	it("carries a NEW daemon's partial net through verbatim (status partial + computed true)", () => {
		const live = {
			status: "partial",
			computed: true,
			netCents: 5000,
			modeled: true,
			costBasis: "measured",
			partial: true,
			missingInputs: ["infra", "pollination"],
		};
		const parsed = RoiNetSectionSchema.parse(live);
		expect(parsed.status).toBe("partial");
		expect(parsed.computed).toBe(true);
		expect(parsed.partial).toBe(true);
		expect(parsed.missingInputs).toEqual(["infra", "pollination"]);
	});
});

describe("RoiViewSchema whole-view back-compat (ISS-011)", () => {
	it("parses a FULL old-daemon RoiView (no new net fields) with the safe net defaults", () => {
		const oldView = {
			savings: {
				status: "ok",
				measuredCents: 100,
				modeledCents: 50,
				assumption: { kind: "memory-injection", assumptionText: "assume x", signedOff: false },
				blendedCentsPerMtok: null,
			},
			infra: { status: "ok", cents: 20, costBasis: "measured" },
			pollination: { status: "ok", cents: 10, lines: [] },
			net: OLD_NET,
			rollups: [],
			perUserAvailable: false,
			scopedAcrossDevices: false,
			ratesAsOf: "2026-07-01",
		};
		const parsed = RoiViewSchema.parse(oldView);
		expect(parsed.net.partial).toBe(false);
		expect(parsed.net.missingInputs).toEqual([]);
		expect(parsed.net.netCents).toBe(12034);
	});

	it("degrades a fully malformed net to the honest-empty net (partial:false included)", () => {
		const parsed = RoiViewSchema.parse({ net: 42 });
		expect(parsed.net).toEqual({ status: "absent", computed: false, netCents: 0, modeled: true, costBasis: "none", partial: false, missingInputs: [] });
	});

	it("EMPTY_ROI_VIEW's net mirrors the additive contract (partial:false, missingInputs:[])", () => {
		expect(EMPTY_ROI_VIEW.net.partial).toBe(false);
		expect(EMPTY_ROI_VIEW.net.missingInputs).toEqual([]);
	});
});
