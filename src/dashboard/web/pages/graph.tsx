/**
 * The MEMORY GRAPH page — PRD-041 (the full-page interactive graph), memory-only.
 *
 * Mounted at the PRD-037 `#/graph` slot. It renders the daemon's MEMORY/knowledge graph full-viewport —
 * every entity and relation the snapshot holds — with a real interactive layout, pan + bounded zoom,
 * click-to-select with a side detail panel, kind filters, and search-to-node.
 *
 * ── Codebase view removed (PRD-041 follow-up) ─────────────────────────────────
 *   This page previously carried a Codebase ↔ Memory toggle. The codebase graph was too dense to be
 *   useful to look at, so the UI now shows ONLY the memory graph (`wire.memoryGraph()`). The codebase
 *   graph is NOT abandoned: the daemon keeps building it in the background (assemble.ts auto-build) so
 *   the stale-ref / memory-lifecycle σ(m,t) diagnostic that reads the snapshot stays fed — it simply no
 *   longer has a viewer here.
 *
 * ── REUSE, do not fork (D-1) ──────────────────────────────────────────────────
 *   Positioning is the SHIPPED pure `layout(nodes, edges, viewBox)` from `graph-layout.ts`
 *   (PRD-035c), parameterized here with full-page dimensions — there is ONE layout function, no
 *   second NODE_POS. Neighbor derivation reuses `neighborsOf` / the `splitNeighbors` direction+relation
 *   split (also pure, in `graph-layout.ts`). The legend reuses the `KIND_COLOR` map exported from
 *   `panels.tsx`. The page builds the full-page experience on the shared primitives.
 *
 * ── Security (D-8) ────────────────────────────────────────────────────────────
 *   Local-mode-only + XSS-safe: every label (memory/entity text — higher-risk) renders as React TEXT,
 *   never `dangerouslySetInnerHTML`. The page reads ONLY the loopback memory-graph endpoint through the
 *   injected `wire` (never `createWireClient`); it adds no token/secret. The shell owns the daemon-down
 *   view-swap (D-9) — this page renders its empty/loading state until the fetch resolves. Every visual
 *   value is an existing `var(--…)` DS token; no new dependency (pan/zoom is hand-rolled over the SVG
 *   viewBox transform).
 */

import React from "react";

import { layout, neighborsOf, splitNeighbors, type Point } from "../graph-layout.js";
import { KIND_COLOR, KIND_COLOR_FALLBACK, SETTING_KEY } from "../panels.js";
import { Badge } from "../primitives.js";
import type { PageProps } from "../page-frame.js";
import { PageFrame } from "../page-frame.js";
import { useScope } from "../scope-context.js";
import { useSwr } from "../use-swr.js";
import { NeedsProjectSelection } from "../needs-project.js";
import { capGraphForRender, EMPTY_GRAPH, ENDPOINTS, MAX_RENDER_NODES, swrKey, type GraphEmptyReason, type GraphWire } from "../wire.js";

/** How often the page re-hydrates the memory graph (ms). Light refresh, stopped on unmount. */
const GRAPH_POLL_MS = 8000;

/**
 * The full-page layout canvas extent — the pure `layout(...)` fits node positions inside this box. Far
 * larger than the mini-widget's 540×200 so a real entity set spreads out (D-2). The SVG scales to its
 * container via `viewBox`; pan/zoom transforms this base box (it is NOT the rendered pixel size).
 */
const GRAPH_VIEW = { width: 1600, height: 1000 } as const;

/** Zoom bounds (D-3): the viewBox scale never goes below/above these so the graph can never invert/vanish. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** The multiplicative zoom step per wheel notch / button press. */
const ZOOM_STEP = 1.15;

/** The pan/zoom view transform over the SVG viewBox: a scale + an (x,y) translate of the base box. */
export interface ViewTransform {
	readonly scale: number;
	readonly tx: number;
	readonly ty: number;
}

/** The identity transform — the fit/reset baseline (whole base box framed, no pan). */
const IDENTITY_TRANSFORM: ViewTransform = { scale: 1, tx: 0, ty: 0 };

/** Clamp a number into `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Compute the SVG `viewBox` string from the base box + the pan/zoom transform. A larger `scale` shows
 * LESS of the base box (zoom in): the visible width is `width / scale`. `tx`/`ty` translate the visible
 * window. Pure — so a test can assert the exact viewBox for a transform (D-3).
 */
export function viewBoxFor(transform: ViewTransform): string {
	const w = GRAPH_VIEW.width / transform.scale;
	const h = GRAPH_VIEW.height / transform.scale;
	return `${transform.tx} ${transform.ty} ${w} ${h}`;
}

/**
 * The distinct node kinds present in a graph, in first-seen order (D-5 / FR-5). The filter controls are
 * derived from THIS — the snapshot's REAL kinds, never a hardcoded list. Pure + unit-assertable.
 */
export function distinctKinds(graph: GraphWire): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const n of graph.nodes) {
		if (!seen.has(n.kind)) {
			seen.add(n.kind);
			out.push(n.kind);
		}
	}
	return out;
}

/**
 * Apply the kind filter to a graph (D-5 / FR-5): drop nodes whose `kind` is in `hidden`, then drop any
 * edge incident to a hidden node (an edge survives only when BOTH endpoints survive). Returns the
 * visible sub-graph; the counts the page shows come straight off its `nodes`/`edges` length. Pure.
 */
export function applyKindFilter(graph: GraphWire, hidden: ReadonlySet<string>): GraphWire {
	if (hidden.size === 0) return graph;
	const nodes = graph.nodes.filter((n) => !hidden.has(n.kind));
	const visibleIds = new Set(nodes.map((n) => n.id));
	const edges = graph.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
	return { built: graph.built, nodes, edges };
}

/**
 * Find the FIRST node matching a search query by `id` or `label` (case-insensitive substring) — D-6 /
 * FR-6. An empty/whitespace query matches nothing (returns null). Pure + unit-assertable. The page
 * focuses + selects the returned node's id.
 */
export function findNode(graph: GraphWire, query: string): string | null {
	const q = query.trim().toLowerCase();
	if (q === "") return null;
	const hit = graph.nodes.find((n) => n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q));
	return hit?.id ?? null;
}

/** Center the view on a node position: pick a `tx`/`ty` that frames `p` in the middle of the visible box. */
export function centerOn(p: Point, scale: number): ViewTransform {
	const w = GRAPH_VIEW.width / scale;
	const h = GRAPH_VIEW.height / scale;
	return { scale, tx: p.x - w / 2, ty: p.y - h / 2 };
}

// ── The kind-filter legend (D-5) ─────────────────────────────────────────────

/** One kind toggle + its swatch + visible count. Toggling flips the kind's hidden state. */
function KindToggle({
	kind,
	count,
	hidden,
	onToggle,
}: {
	kind: string;
	count: number;
	hidden: boolean;
	onToggle: () => void;
}): React.JSX.Element {
	const color = KIND_COLOR[kind] ?? KIND_COLOR_FALLBACK;
	return (
		<button
			type="button"
			role="switch"
			aria-checked={!hidden}
			data-testid={`kind-toggle-${kind}`}
			data-hidden={hidden}
			onClick={onToggle}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 7,
				height: 28,
				padding: "0 11px",
				background: hidden ? "var(--bg-elevated)" : "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-full)",
				color: hidden ? "var(--text-tertiary)" : "var(--text-secondary)",
				fontFamily: "var(--font-mono)",
				fontSize: 12,
				cursor: "pointer",
				opacity: hidden ? 0.55 : 1,
			}}
		>
			<span style={{ width: 9, height: 9, borderRadius: "50%", background: color, flex: "none" }} />
			{kind || "node"}
			<span style={{ color: "var(--text-tertiary)" }}>{count}</span>
		</button>
	);
}

// ── The node detail panel (D-4 / FR-4) ───────────────────────────────────────

/** One relation group row in the detail panel: the relation kind + its neighbor labels, as TEXT. */
function RelationRow({ kind, labels }: { kind: string; labels: readonly string[] }): React.JSX.Element {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
				{kind || "—"} · {labels.length}
			</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", wordBreak: "break-word" }}>
				{labels.join(", ")}
			</span>
		</div>
	);
}

/**
 * The right-hand node DETAIL panel (D-4 / OQ-4). Shows the selected node's `id`, `label`, `kind`, and
 * its neighbors split by DIRECTION (outgoing/incoming) and RELATION (`depends_on`/`supersedes`/… for the
 * memory graph — no special-casing). EVERY rendered value is React text (XSS-safe). `mapLabel` resolves a
 * neighbor id to its display label.
 */
function NodeDetailPanel({
	node,
	graph,
	onClear,
}: {
	node: GraphWire["nodes"][number];
	graph: GraphWire;
	onClear: () => void;
}): React.JSX.Element {
	const { outgoing, incoming } = splitNeighbors(node.id, graph.edges);
	const labelOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.label || id;
	const toLabels = (ids: readonly string[]): string[] => ids.map(labelOf);
	const hasNeighbors = outgoing.length > 0 || incoming.length > 0;

	return (
		<aside
			data-testid="graph-detail-panel"
			style={{
				width: 320,
				flex: "none",
				alignSelf: "stretch",
				padding: 16,
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				display: "flex",
				flexDirection: "column",
				gap: 10,
				overflow: "auto",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ width: 9, height: 9, borderRadius: "50%", background: KIND_COLOR[node.kind] ?? KIND_COLOR_FALLBACK, flex: "none" }} />
				<span style={{ fontSize: 14, color: "var(--text-primary)", minWidth: 0, wordBreak: "break-word" }}>{node.label}</span>
				<span style={{ flex: 1 }} />
				<Badge tone="neutral" mono>
					{node.kind || "node"}
				</Badge>
			</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", wordBreak: "break-all" }}>{node.id}</span>

			<div style={{ height: 1, background: "var(--border-subtle)", margin: "2px 0" }} />

			{!hasNeighbors && <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>no neighbors</span>}

			{outgoing.length > 0 && (
				<div data-testid="detail-outgoing">
					<div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Outgoing</div>
					{outgoing.map((g) => (
						<RelationRow key={`out-${g.kind}`} kind={g.kind} labels={toLabels(g.ids)} />
					))}
				</div>
			)}

			{incoming.length > 0 && (
				<div data-testid="detail-incoming">
					<div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>Incoming</div>
					{incoming.map((g) => (
						<RelationRow key={`in-${g.kind}`} kind={g.kind} labels={toLabels(g.ids)} />
					))}
				</div>
			)}

			<button
				type="button"
				onClick={onClear}
				style={{ height: 28, padding: "0 12px", background: "transparent", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: 12, cursor: "pointer", alignSelf: "flex-start", marginTop: "auto" }}
			>
				clear selection
			</button>
		</aside>
	);
}

// ── The interactive SVG canvas (D-2 / D-3) ────────────────────────────────────

/**
 * The full-page interactive graph canvas. Positions come from the SHARED pure `layout(...)` (D-1),
 * parameterized with {@link GRAPH_VIEW}. Draws one `<line>` per edge whose endpoints both exist and one
 * node group per node (a `<circle>` mark + a `<text>` label — XSS-safe). Pan (drag the background) and
 * bounded zoom (wheel) transform the viewBox via the controlled `transform` prop. Clicking a node
 * selects it; clicking the background clears. Node labels are React text only.
 */
function GraphCanvasFull({
	graph,
	selected,
	transform,
	onSelect,
	onClear,
	onPanZoom,
}: {
	graph: GraphWire;
	selected: string | null;
	transform: ViewTransform;
	onSelect: (id: string) => void;
	onClear: () => void;
	onPanZoom: (next: ViewTransform) => void;
}): React.JSX.Element {
	const positions = React.useMemo(() => layout(graph.nodes, graph.edges, GRAPH_VIEW), [graph]);
	// Track an in-progress background drag (pan). We store the starting client point + the transform at
	// drag start, then translate by the delta scaled into base-box units.
	const drag = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

	const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>): void => {
		// Only a background drag pans — a node click is handled on the node group (stopPropagation).
		drag.current = { x: ev.clientX, y: ev.clientY, tx: transform.tx, ty: transform.ty };
		(ev.currentTarget as SVGSVGElement).setPointerCapture?.(ev.pointerId);
	};
	const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>): void => {
		const d = drag.current;
		if (d === null) return;
		// Convert a client-pixel delta into base-box units: the visible box is `width/scale` wide across
		// the rendered element, so 1 client px ≈ (1/scale) base units (approximate — good enough for pan).
		const dx = (ev.clientX - d.x) / transform.scale;
		const dy = (ev.clientY - d.y) / transform.scale;
		onPanZoom({ scale: transform.scale, tx: d.tx - dx, ty: d.ty - dy });
	};
	const endDrag = (): void => {
		drag.current = null;
	};

	const onWheel = (ev: React.WheelEvent<SVGSVGElement>): void => {
		// Bounded zoom (D-3): a wheel notch multiplies/divides the scale, clamped to [MIN,MAX]. Keep the
		// translate anchored to the base-box origin (a simple, predictable zoom; fit/reset re-frames).
		const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
		const scale = clamp(transform.scale * factor, MIN_ZOOM, MAX_ZOOM);
		onPanZoom({ scale, tx: transform.tx, ty: transform.ty });
	};

	return (
		<svg
			data-testid="graph-canvas"
			viewBox={viewBoxFor(transform)}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerLeave={endDrag}
			onWheel={onWheel}
			onClick={onClear}
			style={{ width: "100%", height: "100%", display: "block", cursor: "grab", touchAction: "none", background: "var(--bg-canvas)" }}
		>
			{graph.edges.map((e, i) => {
				const a = positions.get(e.from);
				const b = positions.get(e.to);
				if (a === undefined || b === undefined) return null;
				return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth={1.5} />;
			})}
			{graph.nodes.map((n) => {
				const p = positions.get(n.id);
				if (p === undefined) return null;
				const isSelected = n.id === selected;
				return (
					<g
						key={n.id}
						role="button"
						tabIndex={0}
						aria-label={`node ${n.label}`}
						aria-pressed={isSelected}
						data-node-id={n.id}
						style={{ cursor: "pointer" }}
						onClick={(ev) => {
							ev.stopPropagation();
							onSelect(n.id);
						}}
					>
						{isSelected && <circle cx={p.x} cy={p.y} r={16} fill="none" stroke="var(--honey)" strokeWidth={2} />}
						<circle cx={p.x} cy={p.y} r={isSelected ? 12 : 9} fill={KIND_COLOR[n.kind] ?? KIND_COLOR_FALLBACK} />
						<text x={p.x + 15} y={p.y + 4} fontFamily="var(--font-mono)" fontSize={13} fill="var(--text-secondary)">
							{n.label}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

// ── Empty state (D-7, reason-branched per ISS-002) ────────────────────────────

/** The shared empty-state shell — one card, four honest bodies (jscpd discipline: one wrapper). */
function EmptyShell({ reason, children }: { reason: GraphEmptyReason | undefined; children: React.ReactNode }): React.JSX.Element {
	return (
		<div
			data-testid="graph-empty-state"
			data-reason={reason ?? "unknown"}
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 10,
				minHeight: 360,
				padding: "48px 16px",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				textAlign: "center",
			}}
		>
			{children}
		</div>
	);
}

/** The empty-state title + hint pair (escaped React text, DS tokens only). */
function EmptyCopy({ title, hint }: { title: string; hint: string }): React.JSX.Element {
	return (
		<>
			<div style={{ fontSize: 15, color: "var(--text-tertiary)" }}>{title}</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", maxWidth: 460 }}>{hint}</span>
		</>
	);
}

/** The bordered-pill action button the empty states share (enable / retry). */
function EmptyAction({ testid, label, disabled, onClick }: { testid: string; label: string; disabled?: boolean; onClick: () => void }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid={testid}
			disabled={disabled}
			onClick={onClick}
			style={{
				height: 32,
				padding: "0 16px",
				marginTop: 6,
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
				color: "var(--text-primary)",
				fontFamily: "var(--font-mono)",
				fontSize: 12,
				cursor: disabled === true ? "default" : "pointer",
				opacity: disabled === true ? 0.6 : 1,
			}}
		>
			{label}
		</button>
	);
}

/**
 * The full-page memory-graph empty state, branched on the daemon's HONEST `reason` (ISS-002 / SP-3 / SP-4):
 *
 *   · `graph_off`       → "Graph persistence is off" + an inline enable affordance that writes
 *                         `graph.enabled=true` through the EXISTING settings save path (`onEnable`),
 *                         then refetches — plus a pointer to Settings. A failed write renders an honest
 *                         failure note, never a fake success.
 *   · `no_entities_yet` → "No entities extracted yet" + the daemon's honest progress counts when present
 *                         ("N memories scanned").
 *   · `query_error`     → an honest error state with a retry (`onRetry` → SWR revalidate).
 *   · absent/unknown    → today's generic neutral note UNCHANGED (an old daemon sends no `reason`; the
 *                         page never guesses). The knowledge graph is populated automatically as memories
 *                         and entities accrue (PRD-008) — still no build command to invent (OQ-6).
 */
function GraphEmptyState({
	reason,
	memoriesScanned,
	onEnable,
	onRetry,
}: {
	reason: GraphEmptyReason | undefined;
	memoriesScanned: number | undefined;
	onEnable: () => Promise<boolean>;
	onRetry: () => void;
}): React.JSX.Element {
	const [enableBusy, setEnableBusy] = React.useState(false);
	const [enableFailed, setEnableFailed] = React.useState(false);
	// A synchronous in-flight guard so a rapid double-click never fires two settings writes.
	const inFlightRef = React.useRef(false);

	const enable = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setEnableBusy(true);
		setEnableFailed(false);
		const ok = await onEnable();
		// On success the parent refetch flips the page (or honestly re-renders whatever the daemon now
		// reports); on failure show the honest "not saved" note — never an optimistic success.
		if (!ok) setEnableFailed(true);
		setEnableBusy(false);
		inFlightRef.current = false;
	}, [onEnable]);

	if (reason === "graph_off") {
		return (
			<EmptyShell reason={reason}>
				<EmptyCopy
					title="Graph persistence is off"
					hint="The daemon is not persisting the knowledge graph for this workspace. Turn it on here (applies live), or from Settings → Memory graph."
				/>
				<EmptyAction testid="graph-enable-button" label={enableBusy ? "enabling…" : "Enable graph persistence"} disabled={enableBusy} onClick={() => void enable()} />
				{enableFailed && (
					<span data-testid="graph-enable-failed" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--severity-warning)" }}>
						not saved — the daemon rejected the write; try again or use{" "}
						<a href="#/settings" style={{ color: "inherit" }}>
							Settings
						</a>
					</span>
				)}
			</EmptyShell>
		);
	}

	if (reason === "no_entities_yet") {
		return (
			<EmptyShell reason={reason}>
				<EmptyCopy
					title="No entities extracted yet"
					hint="Graph persistence is on — entities appear here as memory formation distills sessions. Nothing has been extracted yet."
				/>
				{typeof memoriesScanned === "number" && Number.isFinite(memoriesScanned) && (
					<span data-testid="graph-empty-counts" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
						{memoriesScanned.toLocaleString()} {memoriesScanned === 1 ? "memory" : "memories"} scanned
					</span>
				)}
			</EmptyShell>
		);
	}

	if (reason === "query_error") {
		return (
			<EmptyShell reason={reason}>
				<EmptyCopy
					title="Could not read the memory graph"
					hint="The daemon hit an error querying the graph store. This is usually transient — retry, and check the daemon logs if it persists."
				/>
				<EmptyAction testid="graph-retry-button" label="Retry" onClick={onRetry} />
			</EmptyShell>
		);
	}

	// No reason (old daemon) or an unknown value the schema `.catch()`ed away → the generic state, unchanged.
	return (
		<EmptyShell reason={undefined}>
			<EmptyCopy
				title="No memory graph yet for this workspace."
				hint="The knowledge graph is populated automatically as memories and entities accrue."
			/>
		</EmptyShell>
	);
}

// ── Small toolbar controls ────────────────────────────────────────────────────

/** A compact toolbar button (zoom in/out, fit). Mono, bordered, transparent — matches the kit. */
function ToolButton({ label, ariaLabel, onClick }: { label: string; ariaLabel: string; onClick: () => void }): React.JSX.Element {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			onClick={onClick}
			style={{ width: 30, height: 30, padding: 0, background: "transparent", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: 14, lineHeight: 1, cursor: "pointer" }}
		>
			{label}
		</button>
	);
}

// ── The routed page ───────────────────────────────────────────────────────────

/**
 * The Memory Graph page (PRD-041, memory-only). Hydrates the memory graph via `wire.memoryGraph()`
 * through the shared `wire`, and renders the full-page interactive graph: the shared pure `layout(...)`,
 * pan/zoom over the SVG viewBox, click-to-select → side detail panel, kind filters from the snapshot's
 * real kinds, and search-to-node. `built:false` → the honest full-page empty state. The shell owns the
 * daemon-down swap (D-9), so this page just renders empty/loading until its fetch resolves.
 */
export function GraphPage({ wire }: PageProps): React.JSX.Element {
	// PRD-049e (49e-AC-2): the dashboard-selected project. Threaded into the graph fetcher (so a scope
	// switch re-queries for the new project on the NEXT render) and gating the needs-selection state.
	const { scope } = useScope();
	const project = scope.project;
	const [selected, setSelected] = React.useState<string | null>(null);
	const [hiddenKinds, setHiddenKinds] = React.useState<ReadonlySet<string>>(new Set());
	const [search, setSearch] = React.useState("");
	const [transform, setTransform] = React.useState<ViewTransform>(IDENTITY_TRANSFORM);

	// PRD-012b: the memory graph is now an SWR read with interval refresh. The key encodes the project
	// (re-scopes on switch). `undefined` project disables the hook (no fetch, no conditional-hook
	// violation). The former `alive`/`isTabHidden` guard is now the hook's built-in background-tab pause.
	const graphKey = project !== undefined ? swrKey(ENDPOINTS.memoryGraph, project) : undefined;
	const { data: graph = EMPTY_GRAPH, mutate: mutateGraph } = useSwr<GraphWire>(
		graphKey,
		async () => wire.memoryGraph(project),
		{ refreshInterval: GRAPH_POLL_MS },
	);

	// ISS-002: the `graph_off` inline enable affordance — write `graph.enabled=true` through the
	// EXISTING settings save path (`wire.setSetting`, the same POST /api/settings/:key the Settings
	// page uses; the write also drops the memory-graph SWR entry), then refetch so the page reflects
	// the daemon's post-toggle truth (the vault-first gate applies live via the reload seam).
	const onEnableGraph = React.useCallback(async (): Promise<boolean> => {
		const ok = await wire.setSetting(SETTING_KEY.graphEnabled, true);
		if (ok) mutateGraph();
		return ok;
	}, [wire, mutateGraph]);

	// ISS-002 `query_error` retry: a plain SWR revalidate of the memory-graph read.
	const onRetryGraph = React.useCallback((): void => {
		mutateGraph();
	}, [mutateGraph]);

	const kinds = React.useMemo(() => distinctKinds(graph), [graph]);
	// The visible sub-graph after the kind filter (D-5).
	const visible = React.useMemo(() => applyKindFilter(graph, hiddenKinds), [graph, hiddenKinds]);
	// graph memory cap: bound what the canvas actually draws. The daemon already caps the payload (`graph.meta`);
	// this is the client-side backstop so the page never mounts an unbounded number of SVG nodes. This
	// `rendered` set is what the canvas, counts, selection, and search all read.
	const { graph: rendered, capped } = React.useMemo(() => capGraphForRender(visible, MAX_RENDER_NODES), [visible]);
	// graph memory cap — TWO distinct, separately-reported reductions (never conflated with the kind FILTER,
	// which is a user action, not truncation):
	//   • serverTruncated — the daemon dropped nodes from the snapshot; its honest counts are in `graph.meta`
	//     (shownNodes of totalNodes), independent of any local filter.
	//   • capped — the client render backstop fired (the fetched graph still exceeded MAX_RENDER_NODES).
	const serverTruncated = graph.meta?.truncated ?? false;
	const truncated = serverTruncated || capped;
	// The selected node still present in the RENDERED graph (clears if it was filtered/capped away).
	const selectedNode = selected !== null ? rendered.nodes.find((n) => n.id === selected) ?? null : null;

	const toggleKind = React.useCallback((kind: string): void => {
		setHiddenKinds((prev) => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});
	}, []);

	const onSearch = React.useCallback(
		(raw: string): void => {
			setSearch(raw);
			const hit = findNode(rendered, raw);
			if (hit === null) return;
			setSelected(hit);
			// Focus the match: center the view on its computed position at a comfortable zoom (D-6).
			const positions = layout(rendered.nodes, rendered.edges, GRAPH_VIEW);
			const p = positions.get(hit);
			if (p !== undefined) setTransform(centerOn(p, Math.max(transform.scale, 1.4)));
		},
		[rendered, transform.scale],
	);

	const fit = React.useCallback((): void => setTransform(IDENTITY_TRANSFORM), []);
	const zoomIn = React.useCallback(() => setTransform((t) => ({ ...t, scale: clamp(t.scale * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) })), []);
	const zoomOut = React.useCallback(() => setTransform((t) => ({ ...t, scale: clamp(t.scale / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) })), []);

	const onSelect = React.useCallback((id: string): void => setSelected((cur) => (cur === id ? null : id)), []);
	const clearSelection = React.useCallback((): void => setSelected(null), []);

	const eyebrow = `${rendered.nodes.length} nodes · ${rendered.edges.length} edges`;

	return (
		<PageFrame title="Memory Graph" eyebrow={project === undefined ? "memory graph" : eyebrow}>
			{project === undefined ? (
				// 49e-AC-5: no project selected → the explicit needs-selection state, never another scope's graph.
				<NeedsProjectSelection surface="memory graph" />
			) : !graph.built ? (
				<GraphEmptyState reason={graph.reason} memoriesScanned={graph.memoriesScanned} onEnable={onEnableGraph} onRetry={onRetryGraph} />
			) : (
				<>
					{/* graph memory cap: when the graph is bounded, say so honestly — and source the "N of M" from the
					    daemon's `meta` (NOT the post-filter render count, which the kind filter also shrinks). */}
					{truncated && (
						<div
							data-testid="graph-truncation-notice"
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								marginBottom: 14,
								padding: "9px 12px",
								background: "var(--bg-elevated)",
								border: "1px solid var(--border-subtle)",
								borderRadius: "var(--radius-md)",
								fontFamily: "var(--font-mono)",
								fontSize: 12,
								color: "var(--text-tertiary)",
							}}
						>
							<span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--severity-warning)", flex: "none" }} />
							{serverTruncated
								? `Showing the ${(graph.meta?.shownNodes ?? graph.nodes.length).toLocaleString()} most-connected of ${(graph.meta?.totalNodes ?? graph.nodes.length).toLocaleString()} nodes. Use search and kind filters to focus.`
								: `Rendering is capped at ${MAX_RENDER_NODES.toLocaleString()} nodes. Use search and kind filters to focus.`}
						</div>
					)}

					{/* Controls row: search + kind filters + zoom/fit (D-3/D-5/D-6). */}
					<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
						<input
							aria-label="search nodes"
							data-testid="graph-search"
							type="text"
							value={search}
							placeholder="search id or label…"
							onChange={(e) => onSearch(e.target.value)}
							style={{ height: 30, padding: "0 12px", minWidth: 220, background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 13 }}
						/>
						<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
							{kinds.map((k) => {
								const count = graph.nodes.filter((n) => n.kind === k).length;
								return <KindToggle key={k} kind={k} count={count} hidden={hiddenKinds.has(k)} onToggle={() => toggleKind(k)} />;
							})}
						</div>
						<span style={{ flex: 1 }} />
						<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
							<ToolButton label="−" ariaLabel="zoom out" onClick={zoomOut} />
							<ToolButton label="+" ariaLabel="zoom in" onClick={zoomIn} />
							<button
								type="button"
								data-testid="fit-view"
								onClick={fit}
								style={{ height: 30, padding: "0 12px", background: "transparent", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: 12, cursor: "pointer" }}
							>
								fit
							</button>
						</div>
					</div>

					{/* The canvas + (when a node is selected) the side detail panel. */}
					<div style={{ display: "flex", gap: 16, alignItems: "stretch" }}>
						<div
							style={{
								flex: 1,
								minWidth: 0,
								height: "70vh",
								background: "var(--bg-surface)",
								border: "1px solid var(--border-default)",
								borderRadius: "var(--radius-lg)",
								overflow: "hidden",
							}}
						>
							<GraphCanvasFull
								graph={rendered}
								selected={selectedNode?.id ?? null}
								transform={transform}
								onSelect={onSelect}
								onClear={clearSelection}
								onPanZoom={setTransform}
							/>
						</div>
						{selectedNode !== null && <NodeDetailPanel node={selectedNode} graph={graph} onClear={clearSelection} />}
					</div>
				</>
			)}
		</PageFrame>
	);
}

/** Re-export the pure neighbor helper the page's detail panel relies on (test convenience). */
export { neighborsOf, GraphCanvasFull, KindToggle, ToolButton, IDENTITY_TRANSFORM, GRAPH_VIEW, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP };
