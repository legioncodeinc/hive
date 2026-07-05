export type FleetHealth = "ok" | "degraded" | "unreachable" | "unknown";

export type FleetServiceKind = "daemon" | "supervisor";

export type FleetDaemonStatus = {
  readonly name: string;
  /** Distinguishes supervised workloads from the doctor supervisor row. */
  readonly kind?: FleetServiceKind;
  readonly health: FleetHealth;
  /** Opaque pass-through of doctor's per-daemon escalation record; hive does not interpret it. */
  readonly escalation: unknown;
};

export type FleetStatusResponse =
  | {
      readonly supervisor: "reachable";
      readonly health: FleetHealth;
      readonly daemons: ReadonlyArray<FleetDaemonStatus>;
      readonly asOf: string;
    }
  | { readonly supervisor: "unreachable"; readonly daemons: readonly [] };

export const V1_REQUIRED_PEERS = ["honeycomb"] as const;

/**
 * A daemon "answered": it responded to its `/health` probe at all. `degraded` counts — honeycomb
 * and nectar BOTH boot degraded by design until a workspace is bound (storage unreachable before
 * the first login), which happens AFTER install/onboarding reaches the login step. Gating
 * readiness on `ok` deadlocked fresh-machine onboarding: the health step polled forever waiting
 * for a state only login can produce. Only an explicit no-response (`unreachable`) — or a daemon
 * doctor has never successfully probed (`unknown`) — reads as not ready.
 */
function hasAnswered(health: FleetHealth): boolean {
  return health === "ok" || health === "degraded";
}

export function isFleetReady(status: FleetStatusResponse): boolean {
  if (status.supervisor !== "reachable") return false;
  if (!hasAnswered(status.health)) return false;
  return V1_REQUIRED_PEERS.every((name) =>
    status.daemons.some((daemon) => daemon.name === name && hasAnswered(daemon.health))
  );
}
