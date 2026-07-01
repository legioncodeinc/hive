export const DEFAULT_DAEMON_BASES = Object.freeze({
  honeycomb: "http://127.0.0.1:3850",
  hivenectar: "http://127.0.0.1:3854"
} as const);

export type DaemonName = keyof typeof DEFAULT_DAEMON_BASES;
export type DaemonBases = Record<DaemonName, string>;

const SOURCE_GRAPH_PREFIX = "/api/source-graph";

export function resolveEndpointOwner(endpointPath: string): DaemonName {
  return endpointPath === SOURCE_GRAPH_PREFIX || endpointPath.startsWith(`${SOURCE_GRAPH_PREFIX}/`)
    ? "hivenectar"
    : "honeycomb";
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * The only hostnames a daemon base is trusted to resolve to. thehive aggregates every workload
 * daemon over loopback HTTP by construction (`DAEMON_HOST`/`THEHIVE_HOST` are always
 * `127.0.0.1`); a registry entry naming any other host is rejected rather than trusted, so a
 * tampered `hivedoctor.daemons.json` (or a compromised daemon registration) cannot redirect the
 * server-side proxy (`src/daemon/proxy.ts`) — and the session/memory data it carries in request
 * bodies — to an attacker-controlled origin.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True iff `baseUrl` parses as an absolute URL whose host is a trusted loopback name. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function normalizeDaemonBases(bases: Partial<Record<DaemonName, string>> = {}): DaemonBases {
  return {
    honeycomb: normalizeBaseUrl(bases.honeycomb ?? DEFAULT_DAEMON_BASES.honeycomb),
    hivenectar: normalizeBaseUrl(bases.hivenectar ?? DEFAULT_DAEMON_BASES.hivenectar)
  };
}
