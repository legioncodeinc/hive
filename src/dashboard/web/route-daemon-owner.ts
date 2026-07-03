import type { DaemonName } from "../../shared/daemon-routing.js";

/** Dashboard routes whose primary wire endpoints are owned by nectar (hive-graph proxy). */
const NECTAR_ROUTE_PREFIXES = ["/hive-graph"] as const;

/**
 * Resolve which workload daemon owns the active dashboard route's data plane. Used by the shell's
 * per-owner connectivity gate (PRD-001c c-AC-3): only pages owned by a down daemon swap for the
 * ConnectivityBanner; sibling routes keep rendering via their own fail-soft panels.
 */
export function resolveRouteDaemonOwner(route: string): DaemonName {
	for (const prefix of NECTAR_ROUTE_PREFIXES) {
		if (route === prefix || route.startsWith(`${prefix}/`)) return "nectar";
	}
	return "honeycomb";
}
