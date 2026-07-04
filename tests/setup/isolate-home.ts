/**
 * Suite-wide home isolation (PRD-010 test hygiene).
 *
 * Runs before every test file imports src modules, so even module-load path constants
 * (`HIVE_PID_PATH`, `HIVE_STATE_DIR`, the legacy-window constants) resolve inside a throwaway
 * temp directory. No test may ever read or write the real user home; this file makes that
 * structural: `os.homedir()` honors USERPROFILE (Windows) / HOME (POSIX), both pointed at a
 * fresh mkdtemp dir here. APIARY_HOME / XDG_STATE_HOME are cleared so an operator's own
 * overrides can never leak into a test run (tests inject env through the resolver seams).
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = mkdtempSync(join(tmpdir(), "hive-test-home-"));
mkdirSync(isolatedHome, { recursive: true });

process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;
delete process.env.APIARY_HOME;
delete process.env.XDG_STATE_HOME;
