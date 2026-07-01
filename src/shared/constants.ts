import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };

export const THEHIVE_HOST = "127.0.0.1" as const;
export const THEHIVE_PORT = 3853 as const;
export const THEHIVE_VERSION = packageJson.version;

/** Hard-pinned loopback origin for hivedoctor's status page (fs-AC-2). Never derived from registry or env. */
export const HIVEDOCTOR_STATUS_URL = "http://127.0.0.1:3852/status.json" as const;

export const HONEYCOMB_HOME_DIR = join(homedir(), ".honeycomb");
export const THEHIVE_PID_PATH = join(HONEYCOMB_HOME_DIR, "thehive.pid");
export const THEHIVE_LOCK_PATH = join(HONEYCOMB_HOME_DIR, "thehive.lock");
