/**
 * PRD-009a: the installer service public surface.
 *
 * `server.ts` imports {@link createInstallerService} and registers its routes before the generic
 * `/api/*` BFF proxy. Everything else here is exported for the installer test suites.
 */

export { createInstallerService } from "./routes.js";
export type { InstallerService, InstallerServiceOptions } from "./routes.js";
export { createInstallerConfig } from "./config.js";
export type { InstallerConfig } from "./config.js";
export type { SpawnFn, SpawnOutcome, RawSpawn } from "./spawn.js";
export { createNodeSpawn } from "./spawn.js";
