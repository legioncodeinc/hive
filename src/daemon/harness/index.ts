/**
 * PRD-006c / PRD-006d: the harness-connect service public surface.
 *
 * `server.ts` imports {@link createHarnessConnectService} and registers its routes before the
 * generic `/api/*` BFF proxy. The rest is exported for the harness-connect test suites.
 */

export { createHarnessConnectService } from "./routes.js";
export type { HarnessConnectService, HarnessConnectServiceOptions } from "./routes.js";
export {
	createHoneycombCli,
	isValidHarnessId,
	CONNECT_STATUSES,
	DEFAULT_HARNESS,
	HARNESS_ID_PATTERN,
	HONEYCOMB_BIN,
	HONEYCOMB_CLI_TIMEOUT_MS,
	HONEYCOMB_PACKAGE,
} from "./honeycomb-cli.js";
export type {
	ConnectStatus,
	HarnessConnectResult,
	HarnessConnectionState,
	HarnessRepairResult,
	HarnessStatusReport,
	HoneycombCli,
	HoneycombCliOptions,
} from "./honeycomb-cli.js";
