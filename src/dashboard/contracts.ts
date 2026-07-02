/**
 * PARTIAL copy of honeycomb's `src/dashboard/contracts.ts` — PRD-001b ("copy partially").
 *
 * Only the web-consumed ROI view-model types cross into hive: the subset that
 * `web/wire.ts` (`EMPTY_ROI_TREND`, `EMPTY_ROI_VIEW`, `RoiTrendView`, `RoiView`) and the ROI
 * pages (`web/pages/roi.tsx`, `web/pages/roi-chart.tsx`) import. The rest of honeycomb's
 * contracts serve its own daemon-side view-models and STAY in honeycomb. hive owns a small
 * copy of just the types its `wire` validates against.
 *
 * Copied verbatim from honeycomb `src/dashboard/contracts.ts` (the `PRD-060e` ROI section),
 * with one cross-repo JSDoc `{@link}` path softened to a plain reference so the module is
 * self-contained in hive.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PRD-060e — the composite ROI VIEW-MODEL (the data half: e-AC-2/6/11/12/13/14/15)
//
// The `/roi` page is a PURE FUNCTION of the {@link RoiView} below: every section
// carries an EXPLICIT status discriminant so a measured `$0` is visibly different
// from `unknown`, all money is INTEGER cents (dollars never appear here — formatting
// is the render edge), modeled savings carries its ASSUMPTION as a data field, and the
// daemon (NOT the component) computes the org/team/agent/project rollups. The component
// switches each section on its `status` and never fetches or groups.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-section status discriminant (e-AC-2). Every section of the {@link RoiView}
 * carries ONE of these so the page renders the right treatment per section rather than a
 * single page-wide state:
 *   - `ok`              — a confident, complete figure (measured-or-fully-read).
 *   - `partial`         — populated but degraded (some inputs read, some missing; e.g. "Claude Code only").
 *   - `absent`          — no data yet (the page shows a dash glyph, NOT `$0.00`).
 *   - `unreachable`     — an input could not be read (billing flap → dash + scoped retry).
 *   - `unauthenticated` — no credentials for the input (a Settings-CTA state, redacted).
 * A measured zero is `ok` with a zero figure — DISTINCT from `absent`.
 */
export type RoiSectionStatus = "ok" | "partial" | "absent" | "unreachable" | "unauthenticated";

/**
 * The cost basis a net/cost line rests on (e-AC-15, mirrors PRD-060f `cost_basis`):
 *   - `measured`  — a billed/metered fact (org/workspace infra read from billing).
 *   - `allocated` — an estimated split of a shared cost down to a team/user; carries the
 *                   SAME `est.`-class subordination as a modeled line, never a measured fact.
 *   - `none`      — no cost line applies (e.g. a savings-only rollup).
 * The page renders an `allocated` net distinctly and flags a MIXED-basis rollup.
 */
export type RoiCostBasisTag = "measured" | "allocated" | "none";

/**
 * The modeled assumption carried on the wire as a DATA FIELD (e-AC-8, the daemon-side
 * mirror of 060b's memory-injection assumption). The page's ⓘ popover + page-foot footnote
 * read `assumptionText` VERBATIM from this single source — the page never hardcodes the copy.
 * `signedOff` is `false` until the operator signs off (the page may mark the estimate provisional).
 */
export interface RoiAssumption {
	/** The model-kind machine id (so the page can branch if more models are added). */
	readonly kind: string;
	/** The human-readable assumption string the disclosure surfaces verbatim (the ONE source). */
	readonly assumptionText: string;
	/** Whether the assumption is an operator-signed-off decision (`false` until sign-off). */
	readonly signedOff: boolean;
}

/**
 * The MEASURED + MODELED savings section (e-AC-3). Measured cache savings is the defensible
 * headline (integer cents, `measured` tone); modeled memory-injection savings is the
 * subordinate `est.` line carrying its {@link RoiAssumption}. `blendedCentsPerMtok` is the
 * effective $/Mtok rate — `null` UNTIL token capture is live (the page shows a placeholder,
 * never a fabricated `$0.00`, e-AC-11).
 */
export interface RoiSavingsSection {
	/** The per-section status (e-AC-2): `absent` until any capture lands. */
	readonly status: RoiSectionStatus;
	/** MEASURED cache savings in INTEGER cents (the defensible, billed-fact headline). */
	readonly measuredCents: number;
	/** MODELED memory-injection savings in INTEGER cents (the subordinate `est.` line). */
	readonly modeledCents: number;
	/** The modeled estimate's assumption, carried as data (e-AC-8) — the single disclosure source. */
	readonly assumption: RoiAssumption;
	/** The effective blended rate in cents-per-Mtok, or `null` until capture is live (e-AC-11). */
	readonly blendedCentsPerMtok: number | null;
}

/**
 * The INFRA COST section (e-AC-6, from 060c's billing read-model). `cents` is the measured
 * DeepLake infra cost in INTEGER cents; the `status` carries 060c's billing discriminant so
 * the page distinguishes a billed `$0` (`ok`) from "couldn't read billing" (`unreachable`) /
 * "no credentials" (`unauthenticated`). `costBasis` is `measured` (org/workspace infra is
 * always measured here; a per-team/user allocated share lives on a rollup, not this line).
 */
export interface RoiInfraSection {
	/** The per-section status (e-AC-2/6): how the page tells billed-$0 from couldn't-read. */
	readonly status: RoiSectionStatus;
	/** The measured infra cost in INTEGER cents (`0` when absent — read the STATUS, not the number). */
	readonly cents: number;
	/** The cost basis on this line (e-AC-15): `measured` for org/workspace infra. */
	readonly costBasis: RoiCostBasisTag;
}

/** One pollination contributor split line (the readable per-contributor breakdown the page shows). */
export interface RoiPollinationLine {
	/** The contributor label (e.g. `haiku-skillify`, `deeplake-query`, `deeplake-embedding`). */
	readonly label: string;
	/** This contributor's cost in INTEGER cents. */
	readonly cents: number;
}

/**
 * The POLLINATION COST section (e-AC-6, from 060d's composer). `cents` is the itemized
 * pollination total in INTEGER cents (Haiku skillify + DeepLake GPU sessions); `status` is
 * 060d's worst-of-contributors discriminant mapped onto {@link RoiSectionStatus} so a
 * confident total appears only when both halves are confident. `lines` is the readable split.
 */
export interface RoiPollinationSection {
	/** The per-section status (e-AC-2): the worst of the two contributing halves (060d). */
	readonly status: RoiSectionStatus;
	/** The itemized pollination total in INTEGER cents. */
	readonly cents: number;
	/** The per-contributor split (Haiku + per session_type) the page renders. */
	readonly lines: readonly RoiPollinationLine[];
}

/**
 * The NET-ROI section (e-AC-6). The net (`saved − (infra + pollination)`) is computed ONLY
 * when its inputs are present (status `ok`); a missing/unreachable input leaves the section
 * `unreachable`/`absent` with `computed: false` and `netCents: 0` — the net is NEVER
 * fabricated from incomplete inputs (the page shows a dash glyph + scoped retry). Because the
 * net folds a MODELED savings term it inherits `est.` (`modeled: true`); `costBasis` reflects
 * whether the cost half is measured or carries an allocated share.
 */
export interface RoiNetSection {
	/** The per-section status (e-AC-2/6): `ok` only when every input was present. */
	readonly status: RoiSectionStatus;
	/** True iff the net was actually computed from complete inputs; `false` ⇒ render a dash, not the number. */
	readonly computed: boolean;
	/** The net in INTEGER cents (`0` when `computed: false` — read the STATUS / `computed`, not this). */
	readonly netCents: number;
	/** True — the net folds a modeled term, so it ALWAYS carries `est.` (e-AC-3 net-hero inheritance). */
	readonly modeled: boolean;
	/** The cost basis on the net (e-AC-15): `allocated` when a per-team/user infra share fed it. */
	readonly costBasis: RoiCostBasisTag;
}

/** One ROLLUP dimension the page's dimension switch offers (e-AC-13). */
export type RoiRollupDimension = "org" | "team" | "agent" | "project";

/** One row in a rollup: a dimension key + its summed measured/net cents + the basis flag. */
export interface RoiRollupRow {
	/** The dimension key (the org id / team id / agent id / project id). */
	readonly key: string;
	/** A human label for the key (falls back to the key when no friendlier name resolves). */
	readonly label: string;
	/** Σ measured cache savings for this key, in INTEGER cents. */
	readonly measuredSavingsCents: number;
	/** Σ net (saved − cost) for this key, in INTEGER cents (allocated cost carries `est.`). */
	readonly netCents: number;
	/** Σ infra cost attributed to this key, in INTEGER cents. */
	readonly infraCostCents: number;
	/** The cost basis for THIS row (e-AC-15): `allocated` when its infra share is an estimate. */
	readonly costBasis: RoiCostBasisTag;
	/** Number of sessions (ledger rows) folded into this row. */
	readonly sessions: number;
}

/**
 * One rollup VIEW (e-AC-13): all rows for a single dimension, plus a MIXED-BASIS flag. The
 * daemon computes these as read-time `GROUP BY`s over `roi_metrics` (the component does NO
 * grouping). `mixedBasis` is `true` when the rows span more than one `cost_basis`
 * (`COUNT(DISTINCT cost_basis) > 1`) — the page flags it rather than silently blending.
 */
export interface RoiRollup {
	/** The dimension this rollup groups by (e-AC-13). */
	readonly dimension: RoiRollupDimension;
	/** The grouped rows (one per distinct dimension key). */
	readonly rows: readonly RoiRollupRow[];
	/** True when the rows mix `measured` + `allocated` bases (e-AC-15 mixed-basis flag). */
	readonly mixedBasis: boolean;
}

/**
 * THE COMPOSITE ROI VIEW-MODEL (e-AC-2). The `/roi` page is a PURE FUNCTION of this — every
 * section carries its own {@link RoiSectionStatus}, all money is INTEGER cents, modeled
 * savings carries its assumption as data, the daemon computes the {@link rollups}, and the
 * per-user availability flag is `false` until verified backend claims land (060f gate, today
 * always false). The `scopedAcrossDevices` flag tells the page the figure aggregates across
 * devices (a `shared` read) vs only this machine (an `isolated` read), so the page can caption
 * the scope honestly (e-AC-12).
 */
export interface RoiView {
	/** The measured + modeled savings section (e-AC-3). */
	readonly savings: RoiSavingsSection;
	/** The infra cost section (e-AC-6, from 060c). */
	readonly infra: RoiInfraSection;
	/** The pollination cost section (e-AC-6, from 060d). */
	readonly pollination: RoiPollinationSection;
	/** The net-ROI section (e-AC-6) — computed ONLY from complete inputs, never fabricated. */
	readonly net: RoiNetSection;
	/** The org / team / agent / project rollups (e-AC-13), computed by the daemon as `GROUP BY`s. */
	readonly rollups: readonly RoiRollup[];
	/**
	 * The PER-USER availability flag (e-AC-14): `false` until verified backend user-claims are
	 * live (060f gate). It is `false` today — the page shows the "per-user requires verified
	 * login" empty state and NEVER a `$0` or a self-asserted name when this is false.
	 */
	readonly perUserAvailable: boolean;
	/**
	 * True when the read aggregated ACROSS DEVICES (a `shared` read_policy returned workspace-wide
	 * rows); false when it returned only this machine's rows (an `isolated` read). The page captions
	 * the scope honestly from this (e-AC-12). NOT a tenancy decision — the daemon already scoped the read.
	 */
	readonly scopedAcrossDevices: boolean;
	/** The rate-table "as of" stamp (060b) so a stale rate is auditable on the page. */
	readonly ratesAsOf: string;
}

/** One point in a trend series (e-AC-10): a period label + an INTEGER-cents value + its measured/modeled tag. */
export interface RoiTrendPoint {
	/** The period label (e.g. an ISO date / `YYYY-MM` bucket). */
	readonly period: string;
	/** The value at this period in INTEGER cents. */
	readonly cents: number;
}

/**
 * One trend SERIES (e-AC-10): a named line whose `modeled` tag drives the dashed (modeled) vs
 * solid (measured) stroke. Money is INTEGER cents at every point. The page renders these as an
 * inline-SVG chart (no charting dependency); this contract is purely the data the chart consumes.
 */
export interface RoiTrendSeries {
	/** The series label (e.g. `measured-savings`, `modeled-savings`, `infra-cost`, `net`). */
	readonly label: string;
	/** True ⇒ the chart draws a DASHED stroke (modeled / `est.`); false ⇒ SOLID (measured). */
	readonly modeled: boolean;
	/** The series points, oldest-first, in INTEGER cents. */
	readonly points: readonly RoiTrendPoint[];
}

/**
 * THE TREND VIEW-MODEL (e-AC-10) backing `GET /api/diagnostics/roi/trend`. `series` are the
 * measured-vs-modeled lines (dashed/solid). `status` carries the same {@link RoiSectionStatus}
 * vocabulary so an absent trend (no history before capture started) renders honestly rather
 * than a fabricated flat line; `startedAt` marks when savings tracking began (or `''` when none).
 */
export interface RoiTrendView {
	/** The overall trend status (e-AC-2 vocabulary): `absent` until a history exists. */
	readonly status: RoiSectionStatus;
	/** The measured/modeled series the inline-SVG chart draws (e-AC-10). */
	readonly series: readonly RoiTrendSeries[];
	/** When savings tracking began (ISO), or `''` when there is no history yet ("savings tracked from <date>"). */
	readonly startedAt: string;
}

/**
 * The honest-empty {@link RoiView} the page renders before the first load resolves, on any
 * failure, or on a genuine first-run/empty workspace (e-AC-5). Every section is `absent`
 * (the page shows a DASH glyph, NOT `$0.00`), the net is NOT computed, `blendedCentsPerMtok`
 * is `null`, `perUserAvailable` is `false`, and the rollups are empty. The daemon degrades to
 * THIS rather than throwing, and the wire degrades to it on a malformed/absent body.
 */
export const EMPTY_ROI_VIEW: RoiView = Object.freeze({
	savings: {
		status: "absent" as const,
		measuredCents: 0,
		modeledCents: 0,
		assumption: { kind: "", assumptionText: "", signedOff: false },
		blendedCentsPerMtok: null,
	},
	infra: { status: "absent" as const, cents: 0, costBasis: "none" as const },
	pollination: { status: "absent" as const, cents: 0, lines: [] },
	net: { status: "absent" as const, computed: false, netCents: 0, modeled: true, costBasis: "none" as const },
	rollups: [],
	perUserAvailable: false,
	scopedAcrossDevices: false,
	ratesAsOf: "",
});

/** The honest-empty {@link RoiTrendView} the page renders before first load / on failure / before capture (e-AC-10). */
export const EMPTY_ROI_TREND: RoiTrendView = Object.freeze({
	status: "absent" as const,
	series: [],
	startedAt: "",
});
