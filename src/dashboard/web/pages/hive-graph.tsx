/**
 * PRD-015 — the Hive Graph dashboard page (`/hive-graph`).
 *
 * Renders nectar's file-provenance graph (nodes = nectars, edges = derived_from), a PRD-012 search
 * box, and PRD-008 status/queue/cost widgets. All data hydrates through the shared `wire` + `usePoll`
 * recipe; hive's server-side proxy forwards `/api/hive-graph/*` to nectar (ADR-0002).
 */

import React from "react";

import { layout } from "../graph-layout.js";
import { Panel } from "../panels.js";
import { Badge, Button } from "../primitives.js";
import type { PageProps } from "../page-frame.js";
import { isTabHidden, PageFrame } from "../page-frame.js";
import type { ProjectionDerivedEntry, ProjectionFileEntry } from "../hive-graph-projection.js";
import { NeedsProjectSelection } from "../needs-project.js";
import { FolderPicker } from "../folder-picker.js";
import { useScope } from "../scope-context.js";
import {
	GraphCanvasFull,
	KindToggle,
	ToolButton,
	IDENTITY_TRANSFORM,
	GRAPH_VIEW,
	MIN_ZOOM,
	MAX_ZOOM,
	ZOOM_STEP,
	applyKindFilter,
	centerOn,
	distinctKinds,
} from "./graph.js";
import {
	capGraphForRender,
	EMPTY_GRAPH,
	EMPTY_HIVE_GRAPH_STATUS,
	MAX_RENDER_NODES,
	type GraphWire,
	type HiveGraphBuildAck,
	type HiveGraphHitWire,
	type HiveGraphSearchResultWire,
	type HiveGraphStatusResultWire,
	type NectarProjectRowWire,
	type NectarProjectsWire,
	type SetNectarBroodingBody,
	type WireClient,
	EMPTY_NECTAR_PROJECTS,
} from "../wire.js";
import type { ViewTransform } from "./graph.js";

/** Poll interval for graph + status widgets (mirrors Memory Graph discipline). */
const HIVE_GRAPH_POLL_MS = 8000;

const SURFACE: React.CSSProperties = {
	padding: 16,
	background: "var(--bg-surface)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-lg)",
};

function broodingLabel(state: NectarProjectRowWire["brooding"]): string {
	switch (state) {
		case "active":
			return "brooding";
		case "paused":
			return "paused";
		case "global-paused":
			return "global-paused";
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}

function broodingBadgeTone(state: NectarProjectRowWire["brooding"]): "verified" | "neutral" | "warning" {
	switch (state) {
		case "active":
			return "verified";
		case "paused":
			return "neutral";
		case "global-paused":
			return "warning";
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}

/** PRD-019c — nectar active projects + brooding controls (polls `GET /api/hive-graph/projects`). */
function NectarProjectsPanel({ wire }: { wire: WireClient }): React.JSX.Element {
	const [projectsWire, setProjectsWire] = React.useState<NectarProjectsWire>(EMPTY_NECTAR_PROJECTS);
	const [hydrated, setHydrated] = React.useState(false);
	const [busyKey, setBusyKey] = React.useState<string | null>(null);
	const inFlightRef = React.useRef(false);

	const reList = React.useCallback(async (): Promise<void> => {
		const next = await wire.nectarProjects();
		setProjectsWire(next);
		setHydrated(true);
	}, [wire]);

	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			if (!alive || isTabHidden()) return;
			await reList();
		};
		void tick();
		const id = setInterval(() => void tick(), HIVE_GRAPH_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [reList]);

	const runBroodingWrite = React.useCallback(
		async (body: SetNectarBroodingBody, busy: string): Promise<void> => {
			if (inFlightRef.current || projectsWire.unreachable) return;
			inFlightRef.current = true;
			setBusyKey(busy);
			try {
				const ack = await wire.setNectarBrooding(body);
				if (!ack.unreachable) {
					setProjectsWire(ack);
				}
				await reList();
			} finally {
				inFlightRef.current = false;
				setBusyKey(null);
			}
		},
		[wire, reList, projectsWire.unreachable],
	);

	const onBound = React.useCallback((): void => {
		void reList();
	}, [reList]);

	const controlsDisabled = !hydrated || projectsWire.unreachable || busyKey !== null;

	return (
		<Panel
			title="Nectar projects"
			right={
				<Button
					variant="secondary"
					size="sm"
					data-testid="nectar-global-brooding-toggle"
					disabled={controlsDisabled}
					onClick={() =>
						void runBroodingWrite(
							{ global: projectsWire.globalBrooding === "on" ? "paused" : "on" },
							"global",
						)
					}
				>
					{projectsWire.globalBrooding === "on" ? "Pause all brooding" : "Resume all brooding"}
				</Button>
			}
		>
			{projectsWire.unreachable ? (
				<div
					data-testid="nectar-projects-unreachable"
					style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--severity-critical)" }}
				>
					Nectar is unreachable — project brooding controls are disabled.
				</div>
			) : !hydrated ? (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</span>
			) : projectsWire.projects.length === 0 ? (
				<div data-testid="nectar-needs-project" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
						No active nectar projects yet. Pick a folder to activate brooding for a project directory.
					</div>
					<FolderPicker wire={wire} onBound={onBound} />
				</div>
			) : (
				<div data-testid="nectar-projects-list" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
					{projectsWire.projects.map((project) => (
						<div
							key={project.projectId}
							data-testid="nectar-project-row"
							data-project-id={project.projectId}
							style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 8 }}
						>
							<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
								<span
									data-testid="nectar-project-name"
									style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--honey)" }}
								>
									{project.name !== "" ? project.name : project.projectId}
								</span>
								<Badge tone={broodingBadgeTone(project.brooding)} mono>
									<span data-testid="nectar-brooding-badge">{broodingLabel(project.brooding)}</span>
								</Badge>
								<span style={{ flex: 1 }} />
								<Button
									variant="ghost"
									size="sm"
									data-testid="nectar-brooding-toggle"
									disabled={controlsDisabled}
									onClick={() =>
										void runBroodingWrite(
											{
												projectId: project.projectId,
												brooding: project.brooding === "active" ? "off" : "on",
											},
											project.projectId,
										)
									}
								>
									{project.brooding === "active" ? "Turn off brooding" : "Turn on brooding"}
								</Button>
							</div>
							<span
								data-testid="nectar-project-path"
								style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", wordBreak: "break-all" }}
							>
								{project.path}
							</span>
						</div>
					))}
				</div>
			)}
		</Panel>
	);
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** The file-graph-specific side panel (b-AC-6). */
function FileNodeDetailPanel({
	node,
	file,
	derived,
	onClear,
}: {
	node: GraphWire["nodes"][number];
	file: ProjectionFileEntry | undefined;
	derived: ProjectionDerivedEntry | undefined;
	onClear: () => void;
}): React.JSX.Element {
	return (
		<aside
			data-testid="hive-graph-detail-panel"
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
				<span style={{ fontSize: 14, color: "var(--text-primary)", minWidth: 0, wordBreak: "break-word" }}>{node.label}</span>
				<span style={{ flex: 1 }} />
				<Badge tone="neutral" mono>
					{node.kind || "file"}
				</Badge>
			</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", wordBreak: "break-all" }}>{node.id}</span>
			{file !== undefined && file.description !== "" && (
				<p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.45 }}>{file.description}</p>
			)}
			{derived !== undefined && derived.from_nectar !== "" && (
				<div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
					derived from {derived.from_nectar}
				</div>
			)}
			<button
				type="button"
				onClick={onClear}
				style={{
					height: 28,
					padding: "0 12px",
					background: "transparent",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-md)",
					color: "var(--text-secondary)",
					fontFamily: "var(--font-mono)",
					fontSize: 12,
					cursor: "pointer",
					alignSelf: "flex-start",
					marginTop: "auto",
				}}
			>
				clear selection
			</button>
		</aside>
	);
}

function HiveGraphEmptyState({ unreachable }: { unreachable: boolean }): React.JSX.Element {
	return (
		<div
			data-testid="hive-graph-empty-state"
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
			<div style={{ fontSize: 15, color: "var(--text-tertiary)" }}>
				{unreachable ? "Nectar is unreachable — the Hive Graph is unavailable." : "No Hive Graph yet for this project."}
			</div>
			{!unreachable && (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", maxWidth: 460 }}>
					Describe files with nectar, or trigger a build below, to populate the graph.
				</span>
			)}
		</div>
	);
}

function StatusWidgets({ status }: { status: HiveGraphStatusResultWire }): React.JSX.Element {
	if (status.unreachable) {
		return (
			<div data-testid="hive-graph-status-unavailable" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--severity-critical)" }}>
				Status unavailable — nectar is unreachable.
			</div>
		);
	}
	const ds = status.describeStatus;
	return (
		<div data-testid="hive-graph-status-widgets" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
			<Badge tone="neutral" mono>
				queue {status.queueDepth}
			</Badge>
			<Badge tone="neutral" mono>
				described {ds.described}
			</Badge>
			<Badge tone="neutral" mono>
				pending {ds.pending}
			</Badge>
			<Badge tone="neutral" mono>
				failed {ds.failed}
			</Badge>
			<Badge tone="neutral" mono>
				cost ${status.costSpentUsd.toFixed(2)}
			</Badge>
			{status.degraded && (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>degraded read</span>
			)}
		</div>
	);
}

function SearchResults({
	results,
	onSelect,
}: {
	results: HiveGraphSearchResultWire;
	onSelect: (hit: HiveGraphHitWire) => void;
}): React.JSX.Element {
	if (results.unreachable) {
		return (
			<div data-testid="hive-graph-search-unavailable" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--severity-critical)" }}>
				Search unavailable — nectar is unreachable.
			</div>
		);
	}
	return (
		<div data-testid="hive-graph-search-results" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			{results.hits.length === 0 ? (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>No matches.</span>
			) : (
				results.hits.map((hit) => (
					<button
						key={hit.id}
						type="button"
						data-testid={`hive-graph-search-hit-${hit.id}`}
						onClick={() => onSelect(hit)}
						style={{
							textAlign: "left",
							padding: "10px 12px",
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-subtle)",
							borderRadius: "var(--radius-md)",
							cursor: "pointer",
						}}
					>
						<div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)" }}>{hit.path}</div>
						{hit.body !== "" && (
							<div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.4 }}>{hit.body}</div>
						)}
					</button>
				))
			)}
			{results.degraded && (
				<div data-testid="hive-graph-search-degraded" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
					Search ran in degraded mode (lexical-only or partial index).
				</div>
			)}
		</div>
	);
}

function HiveGraphBuildButton({
	onBuild,
}: {
	onBuild: () => Promise<HiveGraphBuildAck>;
}): React.JSX.Element {
	const [building, setBuilding] = React.useState(false);
	const [ack, setAck] = React.useState<HiveGraphBuildAck | null>(null);
	const inFlightRef = React.useRef(false);

	const run = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setBuilding(true);
		setAck(null);
		try {
			setAck(await onBuild());
		} finally {
			inFlightRef.current = false;
			setBuilding(false);
		}
	}, [onBuild]);

	return (
		<div data-testid="hive-graph-build" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<Button variant="primary" onClick={() => void run()} disabled={building} data-testid="hive-graph-build-button">
				{building ? "Building…" : "Build Hive Graph"}
			</Button>
			{ack !== null && ack.state !== "accepted" && (
				<span
					data-testid="hive-graph-build-message"
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 12,
						color: ack.state === "already_running" ? "var(--severity-warning)" : "var(--severity-critical)",
					}}
				>
					{ack.message}
				</span>
			)}
			{ack !== null && ack.state === "accepted" && (
				<span data-testid="hive-graph-build-accepted" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
					{ack.message}
				</span>
			)}
		</div>
	);
}

/** The routed Hive Graph page (PRD-015). */
export function HiveGraphPage({ wire }: PageProps): React.JSX.Element {
	const { scope } = useScope();
	const project = scope.project;

	const [graph, setGraph] = React.useState<GraphWire>(EMPTY_GRAPH);
	const [files, setFiles] = React.useState<Readonly<Record<string, ProjectionFileEntry>>>({});
	const [derived, setDerived] = React.useState<Readonly<Record<string, ProjectionDerivedEntry>>>({});
	const [graphUnreachable, setGraphUnreachable] = React.useState(false);
	const [status, setStatus] = React.useState<HiveGraphStatusResultWire>({ ...EMPTY_HIVE_GRAPH_STATUS, unreachable: false });

	const [selected, setSelected] = React.useState<string | null>(null);
	const [hiddenKinds, setHiddenKinds] = React.useState<ReadonlySet<string>>(new Set());
	const [transform, setTransform] = React.useState<ViewTransform>(IDENTITY_TRANSFORM);

	const [searchQuery, setSearchQuery] = React.useState("");
	const [searchResults, setSearchResults] = React.useState<HiveGraphSearchResultWire | null>(null);
	const [searching, setSearching] = React.useState(false);

	React.useEffect(() => {
		if (project === undefined) {
			setGraph(EMPTY_GRAPH);
			setFiles({});
			setDerived({});
			setGraphUnreachable(false);
			setStatus({ ...EMPTY_HIVE_GRAPH_STATUS, unreachable: false });
			return;
		}
		let alive = true;
		const tick = async (): Promise<void> => {
			if (!alive || isTabHidden()) return;
			const [graphRes, statusRes] = await Promise.all([wire.hiveGraphFileGraph(project), wire.hiveGraphStatus(project)]);
			if (!alive) return;
			setGraph(graphRes.graph);
			setFiles(graphRes.files);
			setDerived(graphRes.derived);
			setGraphUnreachable(graphRes.unreachable);
			setStatus(statusRes);
		};
		void tick();
		const id = setInterval(() => void tick(), HIVE_GRAPH_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, project]);

	const onSearchSubmit = React.useCallback(async (): Promise<void> => {
		if (project === undefined || searchQuery.trim() === "") return;
		setSearching(true);
		try {
			setSearchResults(await wire.hiveGraphSearch(searchQuery, project));
		} finally {
			setSearching(false);
		}
	}, [wire, project, searchQuery]);

	const focusNode = React.useCallback(
		(nodeId: string): void => {
			setSelected(nodeId);
			const positions = layout(renderedRef.current.nodes, renderedRef.current.edges, GRAPH_VIEW);
			const p = positions.get(nodeId);
			if (p !== undefined) setTransform((t) => centerOn(p, Math.max(t.scale, 1.4)));
		},
		[],
	);

	const kinds = React.useMemo(() => distinctKinds(graph), [graph]);
	const visible = React.useMemo(() => applyKindFilter(graph, hiddenKinds), [graph, hiddenKinds]);
	const { graph: rendered, capped } = React.useMemo(() => capGraphForRender(visible, MAX_RENDER_NODES), [visible]);
	const renderedRef = React.useRef(rendered);
	renderedRef.current = rendered;

	const selectedNode = selected !== null ? rendered.nodes.find((n) => n.id === selected) ?? null : null;

	const toggleKind = React.useCallback((kind: string): void => {
		setHiddenKinds((prev) => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});
	}, []);

	const fit = React.useCallback((): void => setTransform(IDENTITY_TRANSFORM), []);
	const zoomIn = React.useCallback(() => setTransform((t) => ({ ...t, scale: clamp(t.scale * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) })), []);
	const zoomOut = React.useCallback(() => setTransform((t) => ({ ...t, scale: clamp(t.scale / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) })), []);

	const onSelect = React.useCallback((id: string): void => setSelected((cur) => (cur === id ? null : id)), []);
	const clearSelection = React.useCallback((): void => setSelected(null), []);

	const eyebrow = `${rendered.nodes.length} files · ${rendered.edges.length} provenance links`;

	return (
		<PageFrame title="Hive Graph" eyebrow={project === undefined ? "hive graph" : eyebrow}>
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				<NectarProjectsPanel wire={wire} />
				{project === undefined ? (
					<NeedsProjectSelection surface="Hive Graph" />
				) : (
					<>
					<Panel title="Pipeline status" right={<HiveGraphBuildButton onBuild={() => wire.hiveGraphBuild()} />}>
						<StatusWidgets status={status} />
					</Panel>

					<Panel title="Search">
						<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
							<input
								aria-label="search hive graph"
								data-testid="hive-graph-search-input"
								type="text"
								value={searchQuery}
								disabled={project === undefined}
								placeholder="search files and descriptions…"
								onChange={(e) => setSearchQuery(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void onSearchSubmit();
								}}
								style={{
									flex: 1,
									height: 30,
									padding: "0 12px",
									background: "var(--bg-surface)",
									border: "1px solid var(--border-default)",
									borderRadius: "var(--radius-md)",
									color: "var(--text-primary)",
									fontFamily: "var(--font-mono)",
									fontSize: 13,
								}}
							/>
							<Button variant="primary" onClick={() => void onSearchSubmit()} disabled={searching || searchQuery.trim() === ""} data-testid="hive-graph-search-submit">
								{searching ? "Searching…" : "Search"}
							</Button>
						</div>
						{searchResults !== null && <SearchResults results={searchResults} onSelect={(hit) => focusNode(hit.id)} />}
					</Panel>

					{graphUnreachable || !graph.built ? (
						<HiveGraphEmptyState unreachable={graphUnreachable} />
					) : (
						<>
							{capped && (
								<div
									data-testid="hive-graph-truncation-notice"
									style={{
										display: "flex",
										alignItems: "center",
										gap: 8,
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
									Rendering is capped at {MAX_RENDER_NODES.toLocaleString()} nodes. Use search and kind filters to focus.
								</div>
							)}

							<div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
										data-testid="hive-graph-fit-view"
										onClick={fit}
										style={{
											height: 30,
											padding: "0 12px",
											background: "transparent",
											border: "1px solid var(--border-default)",
											borderRadius: "var(--radius-md)",
											color: "var(--text-secondary)",
											fontFamily: "var(--font-mono)",
											fontSize: 12,
											cursor: "pointer",
										}}
									>
										fit
									</button>
								</div>
							</div>

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
								{selectedNode !== null && (
									<FileNodeDetailPanel
										node={selectedNode}
										file={files[selectedNode.id]}
										derived={derived[selectedNode.id]}
										onClear={clearSelection}
									/>
								)}
							</div>
						</>
					)}
				</>
				)}
			</div>
		</PageFrame>
	);
}
