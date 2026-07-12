/**
 * The DASHBOARD page — the zoned home (PRD-038, re-laying the PRD-037b lift-and-shift).
 *
 * PRD-037 lifted the old `app.tsx` body onto this route VERBATIM. PRD-038 reorganizes that body into
 * three named AREA landmarks so the home reads as zones, not one undifferentiated scroll (parent
 * D-1 / AC-1):
 *   1. `<section data-area="kpi-band">`     — the per-subsystem health strip + the four headline KPIs
 *                                             (Memories, Turns, Est. savings, Team skills — 038a).
 *   2. `<section data-area="recall-area">`  — the recall bar + recalled-memory cards + the PRD-029
 *                                             lexical-fallback badge, the centerpiece (038b, moved
 *                                             VERBATIM — same `wire.recall` POST, same render).
 *   3. `<section data-area="harness-area">` — the {@link HarnessStrip} (wired-in chips + per-harness
 *                                             KPI tiles — 038c), then the existing 2-col grid,
 *                                             reorganized into the zone (kept, not dropped).
 *
 * ISS-009: the home's LiveLog mounts (the full live log + the strip's short-tail stream) are GONE —
 * LiveLog belongs only on the Logs page (`#/logs`). A compact "View logs →" link closes the zone
 * instead, and the `/api/logs` poll that fed those tails is removed with them.
 *
 * The page hydrates from the SHARED `wire` the shell passes via
 * {@link PageProps} (it never calls `createWireClient` — the shell builds ONE) and reads the
 * shell-owned `pollinating` flag (D-6: the "Pollinate now" action, the identity, the coarse daemon pill, and
 * the daemon-down swap live in the shell, so this page renders NO header of its own). Every visual
 * value is an existing `var(--…)` DS token; no new token, primitive, or daemon route (AC-7/AC-8).
 */

import React from "react";

import { Badge, Button, Input, Kpi, MemoryCard } from "../primitives.js";
import { RulesPanel, SessionsPanel, SkillSyncPanel, ViewLogsLink } from "../panels.js";
import { HarnessStrip } from "../harness-strip.js";
import { HarnessConnectCard } from "../harness-connect-card.js";
import { useScope } from "../scope-context.js";
import { usePoll, type PageProps } from "../page-frame.js";
import { useSwr } from "../use-swr.js";
import {
	EMPTY_KPIS,
	ENDPOINTS,
	swrKey,
	type HarnessStatusWire,
	type HealthReasonsWire,
	type KpisWire,
	type RecalledMemory,
	type RuleRowWire,
	type SessionRowWire,
	type SkillRowWire,
} from "../wire.js";

/** How often the harness-strip poll re-reads `/api/diagnostics/harnesses` for last-seen recency (ms). */
const HARNESS_POLL_MS = 5000;

/** The recall bar: a mono lg Input + a primary Recall button. Enter and click both fire. */
function RecallBar({
	query,
	setQuery,
	onRecall,
	busy,
}: {
	query: string;
	setQuery: (v: string) => void;
	onRecall: () => void;
	busy: boolean;
}): React.JSX.Element {
	return (
		<div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
			<div style={{ flex: 1 }}>
				<Input
					mono
					size="lg"
					value={query}
					placeholder="recall…  e.g. how do we deploy"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") onRecall();
					}}
				/>
			</div>
			<Button variant="primary" size="lg" onClick={onRecall} disabled={busy}>
				{busy ? "…" : "Recall"}
			</Button>
		</div>
	);
}

/**
 * The PRD-029 "lexical fallback" badge (AC-1). Rendered ONLY when the recall response carried
 * `degraded: true` (embeddings off/absent → lexical BM25/ILIKE). Renders subsystem STATE only — the
 * single closed flag, NO token/org/header (AC-5) — using the kit's `Badge` in the `warning` tone.
 */
function LexicalFallbackBadge(): React.JSX.Element {
	return (
		<span title="recall fell back to lexical (embeddings off) — semantic ranking unavailable" style={{ display: "inline-flex" }}>
			<Badge tone="warning" mono dot>
				lexical fallback
			</Badge>
		</span>
	);
}

/**
 * The display label + degraded predicate + rendered state for one subsystem chip in {@link HealthStrip}.
 * `value` is optional (defaults to the coarse `reasons[key]`) — the `semantic` chip overrides it to the
 * HONEST fine-grained `embeddingsState` so it reads `warming`/`failed`, not a coarse `on`.
 */
const SUBSYSTEMS: readonly {
	readonly key: keyof HealthReasonsWire;
	readonly label: string;
	readonly degraded: (r: HealthReasonsWire) => boolean;
	readonly value?: (r: HealthReasonsWire) => string;
}[] = [
	{ key: "storage", label: "storage", degraded: (r) => r.storage === "unreachable" },
	{
		key: "embeddings",
		label: "semantic",
		// PRD-025 honesty: semantic is "up" only when embeddings are actually WARM (`on`). `off`/`warming`/
		// `failed` all mean semantic recall is not working yet → degraded (recall is lexical meanwhile).
		degraded: (r) => (r.embeddingsState ?? r.embeddings) !== "on",
		value: (r) => String(r.embeddingsState ?? r.embeddings),
	},
	{ key: "schema", label: "schema", degraded: (r) => r.schema === "missing_table" },
	// PRD-063b (b-AC-7): the Portkey gateway chip. `unconfigured` (on but no key) + `unreachable`
	// (a real call failed) are the DOWN states → critical; `off` (not in force) + `ok` are healthy.
	{ key: "portkey", label: "portkey", degraded: (r) => r.portkey === "unconfigured" || r.portkey === "unreachable" },
];

/**
 * The PRD-029 per-subsystem health strip (D-2 render). Reads the `/health` `reasons` block and renders
 * one small chip per subsystem — `storage`, `semantic` (embeddings), `schema` — tinting a degraded one
 * `critical` and a healthy one `verified`. When `reasons` is `null` (the mode-gated public body, which
 * the LOCAL dashboard never gets — defensive) the whole strip renders NOTHING.
 *
 * AC-5: every chip renders a subsystem NAME + a closed-enum STATE only — no token/org/endpoint/header.
 */
function HealthStrip({ reasons }: { reasons: HealthReasonsWire | null }): React.JSX.Element | null {
	if (reasons === null) return null;
	return (
		<div data-testid="health-strip" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
				subsystems
			</span>
			{SUBSYSTEMS.map((s) => {
				const down = s.degraded(reasons);
				const state = s.value !== undefined ? s.value(reasons) : String(reasons[s.key]);
				return (
					<Badge key={s.key} tone={down ? "critical" : "verified"} mono dot>
						{s.label}: {state}
					</Badge>
				);
			})}
		</div>
	);
}

/**
 * The Dashboard route content (the lift-and-shift, D-6). On mount it hydrates every view from the
 * shared `wire` (AC-2) and reads `/health` strip reasons from the shell (PRD-029), and runs recall
 * (AC-3). The `pollinating` pulse is owned by the shell (D-5) and read from props. All polling
 * clears on unmount. NO header — the shell owns the chrome (D-5). ISS-009: no `/api/logs` poll and
 * no LiveLog here — logs live on the Logs page.
 */
export function DashboardPage({ wire, pollinating = false, healthReasons = null }: PageProps): React.JSX.Element {
	// PRD-049e: the active dashboard scope — the selected project re-scopes the KPI band's
	// project-bearing counts (Memories / Turns / Est. savings). Absent → the workspace-wide view.
	const { scope } = useScope();

	// ── view state (hydrated via useSwr — stale-while-revalidate, PRD-012b) ──
	// `healthReasons` is no longer polled here — the SHELL owns the single /health poll and passes the
	// reasons down via PageProps (the former double-poll is gone). It still feeds the subsystem strip.
	// The four reads below replace the former `hydrate` Promise.all bundle (dashboard.tsx ≤012a). The
	// SWR key includes `scope.project` so a project switch naturally re-fetches without a stale-overwrite
	// guard (the former `hydrateSeqRef` is no longer needed — the key change handles invalidation).
	const { data: kpis = EMPTY_KPIS } = useSwr<KpisWire>(
		swrKey(ENDPOINTS.kpis, scope.project),
		async () => wire.kpis(scope.project),
	);
	const { data: sessions = [] } = useSwr<readonly SessionRowWire[]>(
		swrKey(ENDPOINTS.sessions, scope.project),
		async () => wire.sessions(),
	);
	const { data: rules = [] } = useSwr<readonly RuleRowWire[]>(
		swrKey(ENDPOINTS.rules, scope.project),
		async () => wire.rules(),
	);
	const { data: skills = [] } = useSwr<readonly SkillRowWire[]>(
		swrKey(ENDPOINTS.skills, scope.project),
		async () => wire.skills(),
	);

	// ── harness-area state (038c) — the PRD-039 registry/telemetry backbone (`wire.harnesses()`) ──
	const [harnesses, setHarnesses] = React.useState<readonly HarnessStatusWire[]>([]);

	// ── recall state (AC-3) ──
	const [query, setQuery] = React.useState("how do we deploy");
	const [results, setResults] = React.useState<readonly RecalledMemory[]>([]);
	const [recallBusy, setRecallBusy] = React.useState(false);
	const [recalled, setRecalled] = React.useState(false);
	const [recallNonce, setRecallNonce] = React.useState(0);
	const [recallDegraded, setRecallDegraded] = React.useState(false);

	// Defer the below-the-fold harness area to a SECOND paint so the KPI band + recall (what the operator
	// looks at) are interactive first. The flag flips in a passive effect (after the first commit paints),
	// so the heavy strip/grid/log mount on the next render, not the first. The `harness-area` landmark
	// itself always renders (stable layout); only its CONTENTS wait for this.
	const [showSecondary, setShowSecondary] = React.useState(false);
	React.useEffect(() => {
		setShowSecondary(true);
	}, []);

	// 038c: poll the PRD-039 harness registry/telemetry for the wired-in strip + per-harness tiles. A light
	// poll keeps last-seen recency fresh; a failure degrades to [] (wire-safe). Via `usePoll` (gated + cleaned).
	usePoll(async () => setHarnesses(await wire.harnesses()), HARNESS_POLL_MS);

	// AC-3: recall → POST /api/memories/recall → render the hits as MemoryCards.
	const recall = React.useCallback(async (): Promise<void> => {
		const q = query.trim();
		if (q === "" || recallBusy) return;
		setRecallBusy(true);
		// PRD-049e: scope recall to the selected project (mirrors how `hydrate` passes `scope.project`
		// to `wire.kpis`). Without this the recall POST carries no `x-honeycomb-project` header and
		// honeycomb returns workspace-wide hits regardless of the selected Org > Workspace > Project.
		const { memories, degraded } = await wire.recall(q, scope.project);
		setResults(memories);
		setRecalled(true);
		setRecallDegraded(degraded);
		setRecallNonce((n) => n + 1);
		setRecallBusy(false);
	}, [query, recallBusy, wire, scope.project]);

	return (
		<>
			{/* ── AREA 1: the top KPI band (038a) ─────────────────────────────────────────────────── */}
			<section data-area="kpi-band" aria-label="Key metrics" style={{ marginBottom: 22 }}>
				{/* PRD-029 D-2 (render): the per-subsystem health strip, reading the /health reasons. */}
				<HealthStrip reasons={healthReasons} />

				{/* The four headline KPIs (038a-AC-2/AC-3) — corrected Turns/Est. savings/Team skills. */}
				<div className="kpirow">
					<Kpi label="Memories" value={kpis.memoryCount.toLocaleString()} accent="honey" />
					<Kpi label="Turns" value={kpis.turnCount || kpis.sessionCount} accent="neutral" />
					<Kpi label="Est. savings" value={kpis.estimatedSavings.toLocaleString()} unit="tok" accent="verified" />
					<Kpi label="Team skills" value={kpis.teamSkillCount} accent="pollinate" />
				</div>
			</section>

			{/* ── AREA 2: the center recall area (038b) — moved VERBATIM, restyled placement only ──── */}
			<section data-area="recall-area" aria-label="Memory search" style={{ marginBottom: 22 }}>
				<RecallBar query={query} setQuery={setQuery} onRecall={recall} busy={recallBusy} />

				{/* PRD-029 AC-1: the "lexical fallback" badge — shown ONLY when the LAST recall ran degraded. */}
				{recalled && recallDegraded && (
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
							recall
						</span>
						<LexicalFallbackBadge />
					</div>
				)}

				{/* recall results (038b-AC-2/AC-3) */}
				<div style={{ display: "flex", flexDirection: "column", gap: 10 }} key={recallNonce}>
					{results.length === 0
						? recalled && (
								<div style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No memories matched that query.</div>
							)
						: results.map((m, i) => (
								<div className="mem-enter" style={{ animationDelay: `${i * 55}ms` }} key={m.memoryKey}>
									<MemoryCard {...m} pollinating={pollinating && i === 1} />
								</div>
							))}
				</div>
			</section>

			{/* ── AREA 3: the harness area (038c) — the strip, then the retained 2-col grid ── */}
			{/* The landmark always renders (stable layout); its CONTENTS wait for `showSecondary` so the
			    KPI band + recall paint first (below-the-fold deferral). */}
			<section data-area="harness-area" aria-label="Harnesses and activity">
				{showSecondary && (
					<>
						{/* The wired-in chips + per-harness KPI tiles (038c). */}
						<div style={{ marginBottom: 16 }}>
							<HarnessStrip harnesses={harnesses} />
						</div>

						{/* The existing 2-col grid — kept, reorganized into the zone (parent: retain the panels). */}
						<div className="grid2" style={{ marginBottom: 16 }}>
							<div className="col">
								<SessionsPanel sessions={sessions} />
								<RulesPanel rules={rules} />
							</div>
							<div className="col">
								{/* The codebase-graph canvas is intentionally NOT on the home (the graph memory cap): a real snapshot is
								    tens of thousands of nodes and rendering it here froze the browser. The graph lives on its
								    own bounded, memory-aware `#/graph` page; the home stays light.
								    Provider/model/pollinating settings are NOT on the home either — they live on the SETTINGS page
								    (turning pollinating on is a settings action, not a dashboard one); the panel was a duplicate. */}
								<SkillSyncPanel skills={skills} />
							</div>
						</div>

						{/* ISS-009: the full live log is gone — LiveLog belongs to the Logs page only. */}
						<ViewLogsLink />
					</>
				)}
			</section>

			{/* ── AREA 4: the harness-connect card (PRD-006d) — the honeycomb-CLI-backed connect status +
			    Reconnect/Repair. Self-hides when there is nothing to report (the card returns null on an
			    empty read). Deferred with the rest of the below-the-fold content. */}
			<section data-area="harness-connect" aria-label="Coding assistant connections" style={{ marginTop: 16 }}>
				{showSecondary && <HarnessConnectCard wire={wire} />}
			</section>
		</>
	);
}
