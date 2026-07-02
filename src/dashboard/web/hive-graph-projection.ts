/**
 * PRD-015b — client-side transform from nectar's portable projection document
 * (`GET /api/hive-graph/projection`, decision #39) into the shared {@link GraphWire}
 * shape the dashboard graph canvas already renders.
 */

import type { GraphWire } from "./wire.js";

/** One file entry in the portable projection (`src/projection/format.ts`). */
export interface ProjectionFileEntry {
	readonly content_hash: string;
	readonly path: string;
	readonly title: string;
	readonly description: string;
	readonly concepts: readonly string[];
	readonly describe_model: string;
	readonly described_at: string;
}

/** One derived-from entry in the portable projection. */
export interface ProjectionDerivedEntry {
	readonly from_nectar: string;
	readonly fork_content_hash: string;
}

/** The portable projection document the nectar daemon serves. */
export interface PortableProjectionWire {
	readonly version: number;
	readonly generated_at: string;
	readonly generator: string;
	readonly project: {
		readonly org_id: string;
		readonly workspace_id: string;
		readonly project_id: string;
	};
	readonly files: Readonly<Record<string, ProjectionFileEntry>>;
	readonly derived: Readonly<Record<string, ProjectionDerivedEntry>>;
}

/**
 * Derive a file-category kind from a path for the kind filter (b-AC-1). Uses the
 * extension when present, otherwise the top-level directory segment, otherwise `file`.
 */
export function fileKindFromPath(path: string): string {
	const base = path.split("/").pop() ?? path;
	const dot = base.lastIndexOf(".");
	if (dot > 0 && dot < base.length - 1) return base.slice(dot + 1).toLowerCase();
	const first = path.split("/").find((seg) => seg !== "");
	return first !== undefined && first !== "" ? first.toLowerCase() : "file";
}

/**
 * Transform a portable projection into {@link GraphWire}: nodes from `files`, edges from
 * `derived` (`from` = derived nectar, `to` = `from_nectar`, `kind` = `derived_from`).
 * The projection carries no server-side truncation (b-AC-8); density is bounded later by
 * {@link capGraphForRender} on the page.
 */
export function projectionToGraphWire(projection: PortableProjectionWire): GraphWire {
	const nodes = Object.entries(projection.files).map(([id, entry]) => ({
		id,
		label: entry.path,
		kind: fileKindFromPath(entry.path),
	}));
	const edges = Object.entries(projection.derived).map(([derivedNectar, entry]) => ({
		from: derivedNectar,
		to: entry.from_nectar,
		kind: "derived_from",
	}));
	return {
		built: nodes.length > 0,
		nodes,
		edges,
	};
}
