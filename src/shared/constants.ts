import packageJson from "../../package.json" with { type: "json" };
import { resolveHiveLockPath, resolveHivePidPath } from "./apiary-root.js";

export const HIVE_HOST = "127.0.0.1" as const;
export const HIVE_PORT = 3853 as const;
export const HIVE_VERSION = packageJson.version;

/** Hard-pinned loopback origin for doctor's status page (fs-AC-2). Never derived from registry or env. */
export const DOCTOR_STATUS_URL = "http://127.0.0.1:3852/status.json" as const;

/**
 * Hard-pinned loopback origin for doctor's fleet-telemetry SSE stream (hive PRD-004/005;
 * doctor ADR-0001 decision 3). Same status page (`:3852`), the `/events` route. Never derived
 * from the registry or env — mirrors {@link DOCTOR_STATUS_URL}'s fixed-constant posture so the
 * server-side relay (`daemon/telemetry-proxy.ts`) can never be pointed at an attacker-chosen origin.
 */
export const DOCTOR_EVENTS_URL = "http://127.0.0.1:3852/events" as const;

export const HIVE_PID_PATH = resolveHivePidPath();
export const HIVE_LOCK_PATH = resolveHiveLockPath();
