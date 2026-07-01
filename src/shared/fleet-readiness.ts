export type FleetHealth = "ok" | "degraded" | "unreachable" | "unknown";

export type FleetDaemonStatus = {
  readonly name: string;
  readonly health: FleetHealth;
  /** Opaque pass-through of hivedoctor's per-daemon escalation record; thehive does not interpret it. */
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

export function isFleetReady(status: FleetStatusResponse): boolean {
  if (status.supervisor !== "reachable") return false;
  if (status.health !== "ok") return false;
  return V1_REQUIRED_PEERS.every((name) =>
    status.daemons.some((daemon) => daemon.name === name && daemon.health === "ok")
  );
}
