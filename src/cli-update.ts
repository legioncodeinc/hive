import { execFile } from "node:child_process";

import { createServiceModule, type ServiceModule } from "./service/index.js";
import { HIVE_VERSION } from "./shared/constants.js";
import { waitForHiveHealth, type OutputWriter, type RestartCommandDeps } from "./cli-commands.js";

const PACKAGE_NAME = "@legioncodeinc/hive";
const UPDATE_TIMEOUT_MS = 120_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface UpdateExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type UpdateExec = (executable: string, args: readonly string[]) => Promise<UpdateExecResult>;

function createUpdateExec(): UpdateExec {
  return (executable, args) => new Promise((resolve) => {
    execFile(executable, [...args], { timeout: UPDATE_TIMEOUT_MS, shell: false }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr });
    });
  });
}

function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function parseApprovedVersion(stdout: string): string | null {
  let candidate = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed === "string") candidate = parsed;
  } catch {
    // npm may return the version as plain text; validate it below either way.
  }
  return VERSION_PATTERN.test(candidate) ? candidate : null;
}

export interface UpdateCommandDeps extends RestartCommandDeps {
  readonly exec?: UpdateExec;
  readonly platform?: NodeJS.Platform;
  readonly service?: ServiceModule;
  readonly installedVersion?: string;
  readonly out?: OutputWriter;
}

/** Update only from the package's approved npm latest channel, with rollback on failed health. */
export async function runUpdateCommand(cliEntryPath: string, deps: UpdateCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const run = deps.exec ?? createUpdateExec();
  const npm = npmExecutable(deps.platform);
  const installed = deps.installedVersion ?? HIVE_VERSION;
  const lookup = await run(npm, ["view", PACKAGE_NAME, "version", "--json"]);
  const target = lookup.ok ? parseApprovedVersion(lookup.stdout) : null;
  if (target === null) {
    out(`Could not resolve the approved Hive release version. Installed: ${installed}.\n`);
    return 1;
  }
  out(`Installed: ${installed}; approved target: ${target}.\n`);
  if (target === installed) {
    out("hive is already up to date.\n");
    return 0;
  }

  const service = deps.service ?? createServiceModule({ execPath: cliEntryPath });
  const wasInstalled = await service.isRegistered();
  if (wasInstalled) {
    const stopped = await service.stop();
    if (!stopped.ok) {
      out(`${stopped.message}\n`);
      return 1;
    }
  }

  const update = await run(npm, ["install", "--global", `${PACKAGE_NAME}@${target}`]);
  if (!update.ok) {
    out(`Hive update to ${target} failed; existing state was preserved.\n`);
    if (wasInstalled) await service.start();
    return 1;
  }

  if (wasInstalled) {
    const started = await service.start();
    if (started.ok && await waitForHiveHealth(deps)) {
      out(`hive updated from ${installed} to ${target}; state was preserved and health verified.\n`);
      return 0;
    }

    out(`Hive ${target} failed post-update health verification; rolling back to ${installed}.\n`);
    await service.stop();
    const rollback = await run(npm, ["install", "--global", `${PACKAGE_NAME}@${installed}`]);
    const restarted = rollback.ok ? await service.start() : { ok: false, message: "rollback install failed" };
    const recovered = restarted.ok && await waitForHiveHealth(deps);
    out(recovered
      ? `Rollback to ${installed} completed; update failed.\n`
      : `Rollback to ${installed} did not recover Hive; manual repair is required.\n`);
    return 1;
  }

  out(`hive updated from ${installed} to ${target}; state was preserved.\n`);
  return 0;
}

export const updateCommandInternals = { npmExecutable, parseApprovedVersion };
