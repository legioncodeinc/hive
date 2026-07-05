import { z } from "zod";

import { DOCTOR_STATUS_URL } from "../shared/constants.js";
import { isLoopbackBaseUrl } from "../shared/daemon-routing.js";
import {
  isFleetReady,
  V1_REQUIRED_PEERS,
  type FleetDaemonStatus,
  type FleetHealth,
  type FleetServiceKind,
  type FleetStatusResponse
} from "../shared/fleet-readiness.js";

export type { FleetDaemonStatus, FleetHealth, FleetStatusResponse };
export { isFleetReady, V1_REQUIRED_PEERS };

const UNREACHABLE_RESPONSE = {
  supervisor: "unreachable",
  daemons: []
} as const satisfies FleetStatusResponse;

const FleetHealthSchema = z.enum(["ok", "degraded", "unreachable", "unknown"]);

const FleetDaemonSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["daemon", "supervisor"] as const satisfies readonly FleetServiceKind[]).optional(),
  health: FleetHealthSchema,
  escalation: z.unknown().nullable().optional()
});

const DoctorStatusSchema = z.object({
  health: FleetHealthSchema,
  daemons: z.array(FleetDaemonSchema).optional().default([]),
  asOf: z.string().min(1)
});

/**
 * Minimal init surface for the status fetch. `redirect` is pinned (fs-AC-9 defense in depth on top
 * of the loopback URL pin): native fetch defaults to `redirect: "follow"`, so a rogue or compromised
 * loopback service answering on :3852 could 3xx-redirect hive's fetch to a non-loopback origin,
 * silently defeating `isLoopbackBaseUrl()` (which only validates the initial URL). Pinning
 * `redirect: "error"` makes fetch reject on any redirect, so the off-loopback request never fires.
 */
export type FleetFetchInit = { readonly redirect?: "error" | "follow" | "manual" };
export type FetchImpl = (input: string, init?: FleetFetchInit) => Promise<Response>;

const DOCTOR_SUPERVISOR_NAME = "doctor";

function withDoctorSupervisorEntry(
  daemons: readonly z.infer<typeof FleetDaemonSchema>[],
  supervisorHealth: FleetHealth
): FleetDaemonStatus[] {
  const normalized = daemons.map((daemon): FleetDaemonStatus => ({
    name: daemon.name,
    kind: daemon.kind,
    health: daemon.health,
    escalation: daemon.escalation ?? null
  }));
  const doctorNameMatch = (name: string): boolean => name.toLowerCase() === DOCTOR_SUPERVISOR_NAME;
  if (normalized.some((daemon) => doctorNameMatch(daemon.name))) {
    return normalized.map((daemon) => (doctorNameMatch(daemon.name) ? { ...daemon, kind: "supervisor" } : daemon));
  }
  return [...normalized, { name: DOCTOR_SUPERVISOR_NAME, kind: "supervisor", health: supervisorHealth, escalation: null }];
}

export async function fetchFleetStatus(
  fetchImpl: FetchImpl = fetch,
  url: string = DOCTOR_STATUS_URL
): Promise<FleetStatusResponse> {
  if (!isLoopbackBaseUrl(url)) {
    return UNREACHABLE_RESPONSE;
  }

  try {
    const response = await fetchImpl(url, { redirect: "error" });
    if (!response.ok) {
      return UNREACHABLE_RESPONSE;
    }

    let parsedJson: unknown;
    try {
      parsedJson = await response.json();
    } catch {
      return UNREACHABLE_RESPONSE;
    }

    const parsed = DoctorStatusSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return UNREACHABLE_RESPONSE;
    }

    return {
      supervisor: "reachable",
      health: parsed.data.health,
      daemons: withDoctorSupervisorEntry(parsed.data.daemons, parsed.data.health),
      asOf: parsed.data.asOf
    };
  } catch {
    return UNREACHABLE_RESPONSE;
  }
}
