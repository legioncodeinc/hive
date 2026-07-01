import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };

export const THEHIVE_HOST = "127.0.0.1" as const;
export const THEHIVE_PORT = 3853 as const;
export const THEHIVE_VERSION = packageJson.version;

export const HONEYCOMB_HOME_DIR = join(homedir(), ".honeycomb");
export const THEHIVE_PID_PATH = join(HONEYCOMB_HOME_DIR, "thehive.pid");
export const THEHIVE_LOCK_PATH = join(HONEYCOMB_HOME_DIR, "thehive.lock");
