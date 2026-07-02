import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };

export const THEHIVE_HOST = "127.0.0.1" as const;
export const THEHIVE_PORT = 3853 as const;
export const THEHIVE_VERSION = packageJson.version;

/** Hard-pinned loopback origin for hivedoctor's status page (fs-AC-2). Never derived from registry or env. */
export const HIVEDOCTOR_STATUS_URL = "http://127.0.0.1:3852/status.json" as const;

/**
 * Hard-pinned loopback origin for hivedoctor's fleet-telemetry SSE stream (the-hive PRD-004/005;
 * hivedoctor ADR-0001 decision 3). Same status page (`:3852`), the `/events` route. Never derived
 * from the registry or env — mirrors {@link HIVEDOCTOR_STATUS_URL}'s fixed-constant posture so the
 * server-side relay (`daemon/telemetry-proxy.ts`) can never be pointed at an attacker-chosen origin.
 */
export const HIVEDOCTOR_EVENTS_URL = "http://127.0.0.1:3852/events" as const;

export const HONEYCOMB_HOME_DIR = join(homedir(), ".honeycomb");
export const THEHIVE_PID_PATH = join(HONEYCOMB_HOME_DIR, "thehive.pid");
export const THEHIVE_LOCK_PATH = join(HONEYCOMB_HOME_DIR, "thehive.lock");
