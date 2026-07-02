/**
 * Shared fleet-TELEMETRY shapes — the-hive PRD-004/PRD-005, mirroring hivedoctor's
 * `src/telemetry/schema.ts` (Contract C in `library/ledger/EXECUTION_LEDGER.md`).
 *
 * thehive does not depend on the hivedoctor package (each fleet member is its own published
 * npm package), so this module is a hand-kept, browser-and-server-safe COPY of the wire shape
 * hivedoctor's SSE stream (`GET http://127.0.0.1:3852/events`, event `fleet-telemetry`) actually
 * emits. Keep it in lockstep with hivedoctor's schema.ts if that contract ever changes.
 *
 * `metrics` is deliberately `Readonly<Record<string, number>>`: honeycomb ships three counters
 * (`actionsTaken`, `filesProcessed`, `memoriesCreated`), hivenectar ships five
 * (`filesRegistered`, `nectarsMinted`, `descriptionsGenerated`, `sourceGraphVersions`,
 * `embeddingsComputed`) — every reader built on this module (PRD-005b's metrics render, PRD-004c's
 * derivation) is schema-tolerant by construction: it never hardcodes one service's key names.
 */

import { z } from "zod";

/** Coarse fleet-visible health for one service (matches `../daemon/fleet-status.ts`'s `FleetHealth`). */
export type FleetHealth = "ok" | "degraded" | "unreachable" | "unknown";

/** A schema-tolerant metrics snapshot: whatever counters a service's telemetry DB reports, camelCased. */
export type ServiceMetrics = Readonly<Record<string, number>>;

/** Why a service's telemetry read was skipped this hivedoctor poll tick (fault isolation, sd-AC-9). */
export type TelemetryFaultReason = "missing" | "locked" | "malformed" | "read-error";

/** Deep Lake connection/stats fields carried on one service's fleet model (PRD-005b hm-AC-5/hm-AC-6). */
export interface FleetDeeplakeStats {
	readonly connected: boolean | null;
	readonly lastCommunicationAt: string | null;
}

/**
 * One service's merged fleet-model row, as hivedoctor's poll loop emits it: the static
 * "should exist" registry entry plus its live runtime status. A registered-but-silent service
 * appears here with `health: "unknown"` and `lastSeen: null` (never omitted, never a false
 * `active` — sd-AC-2).
 */
export interface FleetServiceModel {
	readonly name: string;
	readonly health: FleetHealth;
	/** ISO-8601 of the last confirmed check-in, or `null` when never seen. Stops advancing (not cleared) on disconnect. */
	readonly lastSeen: string | null;
	readonly metrics: ServiceMetrics;
	/** `null` when the service has no telemetry DB, or has one but never checked in. */
	readonly deeplake: FleetDeeplakeStats | null;
	/** Non-null when this service's telemetry DB was skipped THIS tick, isolated from the rest of the fleet. */
	readonly telemetryFault: TelemetryFaultReason | null;
}

/** One forwarded log line, tagged with its originating service (PRD-005c). */
export interface FleetLogEntry {
	readonly service: string;
	readonly ts: string;
	readonly level: string;
	readonly message: string;
}

/**
 * The single `fleet-telemetry` SSE event payload. `logs` is a BOUNDED SLICE of only the new rows
 * since the previous tick (never a full history), so every consumer built on this stays
 * memory-bounded by construction (PRD-005 parent index's hard constraint).
 */
export interface FleetTelemetryEvent {
	readonly asOf: string;
	readonly services: readonly FleetServiceModel[];
	readonly logs: readonly FleetLogEntry[];
}

/** The one SSE event name hivedoctor's stream ever emits (mirrors hivedoctor's `ingestion/sse.ts`). */
export const FLEET_TELEMETRY_EVENT_NAME = "fleet-telemetry" as const;

// ── Defensive parse (untrusted transport boundary: the SSE frame body / the JSON fetch body) ──

const FleetHealthSchema = z.enum(["ok", "degraded", "unreachable", "unknown"]);
const TelemetryFaultReasonSchema = z.enum(["missing", "locked", "malformed", "read-error"]);

const FleetDeeplakeStatsSchema = z.object({
	connected: z.boolean().nullable(),
	lastCommunicationAt: z.string().nullable(),
});

const FleetServiceModelSchema = z.object({
	name: z.string().min(1),
	health: FleetHealthSchema,
	lastSeen: z.string().nullable(),
	metrics: z.record(z.string(), z.number()),
	deeplake: FleetDeeplakeStatsSchema.nullable(),
	telemetryFault: TelemetryFaultReasonSchema.nullable(),
});

const FleetLogEntrySchema = z.object({
	service: z.string().min(1),
	ts: z.string().min(1),
	level: z.string().min(1),
	message: z.string(),
});

const FleetTelemetryEventSchema = z.object({
	asOf: z.string().min(1),
	services: z.array(FleetServiceModelSchema),
	logs: z.array(FleetLogEntrySchema),
});

/**
 * Defensively parse one `fleet-telemetry` SSE frame's `data:` JSON (or the same shape from any
 * future JSON transport). Returns `null` on anything malformed rather than throwing, so one bad
 * frame never crashes the consuming hook (mirrors `fleet-status.ts`'s `safeParse`-and-degrade posture).
 */
export function parseFleetTelemetryEvent(raw: string): FleetTelemetryEvent | null {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = FleetTelemetryEventSchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : null;
}
