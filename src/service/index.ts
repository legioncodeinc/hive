import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { resolveStagedWindowsTaskPath } from "../shared/apiary-root.js";
import { migrateHiveState } from "../shared/state-migration.js";
import {
  installCommands,
  legacyUninstallCommands,
  startCommands,
  stopCommands,
  uninstallCommands,
  type ServiceCommand
} from "./commands.js";
import {
  legacyUnitPath,
  LEGACY_WINDOWS_TASK_NAME,
  resolveServiceContext,
  resolveServicePlan,
  WINDOWS_TASK_NAME,
  type ServiceEnvironment,
  type ServicePlan
} from "./platform.js";
import { renderUnit } from "./templates.js";
import { resolveWindowsUserId as resolveWindowsUserIdDefault } from "./windows-identity.js";

const SERVICE_COMMAND_TIMEOUT_MS = 15_000;

export interface CommandResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly detail?: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { readonly timeoutMs?: number }): Promise<CommandResult>;
}

export interface ServiceFs {
  mkdirp(path: string): void;
  writeFile(path: string, content: string): void;
  removeFile(path: string): void;
  fileExists(path: string): boolean;
  isSymbolicLink(path: string): boolean;
}

export interface ServiceResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * The outcome of {@link ServiceModule.uninstall}, additionally classified so a
 * caller can tell a genuine removal failure from the current unit simply
 * having been absent already (M-2 / PRD-003b AC-9, b-AC-6): on macOS the
 * `uninstall` verb runs `stop` (launchd `bootout`) before `service.uninstall()`
 * issues its own `bootout` of the same unit, so the second call always finds
 * "No such process" after a fully successful stop. A boot-resurrecting unit
 * left behind by a swallowed "it was probably already gone" error is exactly
 * the failure mode this classification exists to catch, so `alreadyAbsent`
 * stays `false` for anything that does not match a known not-found signal.
 */
export interface ServiceUninstallResult extends ServiceResult {
  /**
   * True when the manager reported the current unit was not registered/found
   * rather than a real error (permission denied, manager unreachable, etc.).
   * A true `alreadyAbsent` is a friendly no-op; `ok` stays false either way
   * since nothing was actually removed by THIS call - callers should treat
   * `alreadyAbsent === true` the same as `ok === true` for exit-code purposes.
   */
  readonly alreadyAbsent: boolean;
}

export interface ServiceModule {
  install(): Promise<ServiceResult>;
  start(): Promise<ServiceResult>;
  stop(): Promise<ServiceResult>;
  uninstall(): Promise<ServiceUninstallResult>;
  isRegistered(): Promise<boolean>;
}

export interface ServiceModuleDeps {
  readonly execPath: string;
  readonly runner?: CommandRunner;
  readonly fs?: ServiceFs;
  readonly uid?: number;
  readonly environment?: ServiceEnvironment;
  /**
   * PRD-010b migration seam run on `install()`. Defaults to the real {@link migrateHiveState}
   * against the plan's home; tests MUST inject a no-op so a fake `home` never touches real disk.
   */
  readonly migrateState?: (environment: ServiceEnvironment) => void;
  /**
   * Windows-only seam resolving the SID (or `domain\user` fallback) embedded as the schtasks
   * `LogonTrigger`/`Principal` `UserId` (see `templates.ts` `renderScheduledTaskXml`). Defaults to
   * the real {@link resolveWindowsUserId} (execFile of `whoami.exe`, never a shell); tests MUST
   * inject a fixed value so a run never shells out. Never invoked for launchd/systemd plans.
   */
  readonly resolveWindowsUserId?: () => Promise<string | null>;
}

export function createExecFileRunner(): CommandRunner {
  return {
    run(command, args, options = {}): Promise<CommandResult> {
      const timeout = options.timeoutMs ?? SERVICE_COMMAND_TIMEOUT_MS;
      return new Promise((resolve) => {
        execFile(command, [...args], { timeout }, (error, stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, code: 0, stdout, stderr });
            return;
          }

          const codeValue = typeof error.code === "number" ? error.code : null;
          resolve({
            ok: false,
            code: codeValue,
            stdout,
            stderr,
            detail: error.message
          });
        });
      });
    }
  };
}

export function createNodeServiceFs(): ServiceFs {
  return {
    mkdirp(path: string): void {
      mkdirSync(path, { recursive: true });
    },
    writeFile(path: string, content: string): void {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("refusing non-file service unit");
        ftruncateSync(fd, 0);
        writeFileSync(fd, content, "utf8");
      } finally {
        closeSync(fd);
      }
    },
    removeFile(path: string): void {
      rmSync(path, { force: true });
    },
    fileExists(path: string): boolean {
      return existsSync(path);
    },
    isSymbolicLink(path: string): boolean {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
  };
}

function liveUid(): number {
  try {
    const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
    return typeof getuid === "function" ? getuid() : 0;
  } catch {
    return 0;
  }
}

function stagedWindowsTaskPath(home: string): string {
  return resolveStagedWindowsTaskPath({ home, env: process.env });
}

function scopePhrase(plan: ServicePlan): string {
  switch (plan.manager) {
    case "launchd":
      return "launchd";
    case "systemd":
      return "systemd";
    case "schtasks":
      return "schtasks";
  }
}

async function runAll(
  runner: CommandRunner,
  commands: readonly ServiceCommand[],
  options: {
    readonly isNonFatalFailure?: (command: ServiceCommand, result: CommandResult) => boolean;
  } = {}
): Promise<{
  readonly allOk: boolean;
  readonly firstFailure: ServiceCommand | null;
  readonly firstFailureResult: CommandResult | null;
}> {
  let firstFailure: ServiceCommand | null = null;
  let firstFailureResult: CommandResult | null = null;
  for (const command of commands) {
    const result = await runner.run(command.command, command.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
    if (!result.ok && options.isNonFatalFailure?.(command, result)) {
      continue;
    }
    if (!result.ok && firstFailure === null) {
      firstFailure = command;
      firstFailureResult = result;
    }
  }
  return { allOk: firstFailure === null, firstFailure, firstFailureResult };
}

/** Cap how much of a command's own output is ever echoed back in a result message. */
const MAX_FAILURE_DETAIL_CHARS = 200;

function lastNonEmptyLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

/**
 * Reduce a failed {@link CommandResult} to one short, secret-free line worth
 * surfacing to the operator (e.g. "No such process", "Access is denied.").
 * Prefers the runner's own `detail` (a spawn-error message); otherwise falls
 * back to the last non-empty line of stderr, then stdout, since launchctl/
 * systemctl/schtasks all print their real error there. A genuine failure must
 * surface the underlying error rather than a generic "something failed" -
 * that is what lets an operator tell a real problem from a no-op.
 */
function describeFailure(result: CommandResult | null): string {
  if (result === null) return "unknown error";
  const candidate =
    result.detail ?? lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout) ?? "unknown error";
  return candidate.length > MAX_FAILURE_DETAIL_CHARS
    ? `${candidate.slice(0, MAX_FAILURE_DETAIL_CHARS)}...`
    : candidate;
}

/**
 * True when a failed stop/uninstall command's result indicates the unit was
 * already absent (not currently registered/running) rather than a genuine
 * failure. Each service manager reports "not found" differently; launchd's
 * `ESRCH`-derived exit code (3) is locale-independent so it is checked
 * directly. Every manager additionally falls back to a broad, case-insensitive
 * text match over stdout/stderr/detail. Anything that does not match is
 * conservatively treated as a GENUINE failure (never silently swallowed) -
 * this is the classification M-2 / AC-9 / b-AC-6 depend on.
 */
function isAlreadyAbsentFailure(manager: ServicePlan["manager"], result: CommandResult | null): boolean {
  if (result === null) return false;
  const text = `${result.detail ?? ""} ${result.stderr} ${result.stdout}`.toLowerCase();
  const genericAbsent = /does not exist|cannot find|no such process|not[- ]loaded|could not find|not found/;
  switch (manager) {
    case "launchd":
      return result.code === 3 || genericAbsent.test(text);
    case "systemd":
      return genericAbsent.test(text);
    case "schtasks":
      return genericAbsent.test(text);
    default: {
      const unreachable: never = manager;
      return unreachable;
    }
  }
}

function isAlreadyRunningTaskFailure(result: CommandResult | null): boolean {
  if (result === null) return false;
  const text = `${result.detail ?? ""} ${result.stderr} ${result.stdout}`.toLowerCase();
  return /already running|instance of the task.*running|task is currently running|cannot run because.*running/.test(
    text
  );
}

function isBenignInstallFailure(
  resolvedPlan: ServicePlan,
  command: ServiceCommand,
  result: CommandResult | null
): boolean {
  if (resolvedPlan.manager !== "schtasks") return false;
  if (command.command !== "schtasks") return false;
  if (command.args[0] !== "/Run") return false;
  return isAlreadyRunningTaskFailure(result);
}

function withResolvedUnitPath(plan: ServicePlan): ServicePlan {
  if (plan.manager !== "schtasks" || plan.unitPath !== "") return plan;
  return {
    ...plan,
    unitPath: stagedWindowsTaskPath(plan.home)
  };
}

export function createServiceModule(deps: ServiceModuleDeps): ServiceModule {
  const runner = deps.runner ?? createExecFileRunner();
  const fs = deps.fs ?? createNodeServiceFs();
  const uid = deps.uid ?? liveUid();
  const environment = deps.environment ?? resolveServiceContext(deps.execPath);
  const migrateState =
    deps.migrateState ??
    ((env: ServiceEnvironment): void => {
      migrateHiveState({ home: env.home, env: process.env });
    });
  const resolveWindowsUserId = deps.resolveWindowsUserId ?? (() => resolveWindowsUserIdDefault());

  function plan(): ServicePlan {
    return resolveServicePlan(environment);
  }

  async function isCurrentRegisteredForPlan(resolvedPlan: ServicePlan): Promise<boolean> {
    if (resolvedPlan.manager === "schtasks") {
      const current = await runner.run("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], {
        timeoutMs: SERVICE_COMMAND_TIMEOUT_MS
      });
      return current.ok;
    }
    return resolvedPlan.unitPath !== "" && fs.fileExists(resolvedPlan.unitPath);
  }

  async function isRegisteredForPlan(resolvedPlan: ServicePlan): Promise<boolean> {
    if (await isCurrentRegisteredForPlan(resolvedPlan)) return true;
    if (resolvedPlan.manager === "schtasks") {
      const legacy = await runner.run("schtasks", ["/Query", "/TN", LEGACY_WINDOWS_TASK_NAME], {
        timeoutMs: SERVICE_COMMAND_TIMEOUT_MS
      });
      return legacy.ok;
    }

    const legacyPath = legacyUnitPath(resolvedPlan);
    return legacyPath !== "" && fs.fileExists(legacyPath);
  }

  return {
    async isRegistered(): Promise<boolean> {
      try {
        return await isRegisteredForPlan(withResolvedUnitPath(plan()));
      } catch {
        return false;
      }
    },

    async install(): Promise<ServiceResult> {
      let resolvedPlan: ServicePlan;
      try {
        resolvedPlan = withResolvedUnitPath(plan());
      } catch (error) {
        return {
          ok: false,
          message: `Could not register hive service: ${error instanceof Error ? error.message : "unknown error"}.`
        };
      }

      // PRD-010b: converge hive state paths before rendering/registering the unit.
      migrateState(environment);

      // Decision #32 migration: best-effort deregister the legacy `hive` unit and
      // remove its unit file, so a re-run never leaves two units racing over one daemon.
      // Expected to fail harmlessly when no legacy unit exists; never blocks the install.
      await runAll(runner, legacyUninstallCommands(resolvedPlan, uid));
      try {
        const legacyPath = legacyUnitPath(resolvedPlan);
        if (legacyPath !== "") fs.removeFile(legacyPath);
      } catch {
        // Best-effort migration cleanup only; a remove failure never blocks the install.
      }

      const needsUnitFile = resolvedPlan.unitPath !== "" || resolvedPlan.manager === "schtasks";
      if (needsUnitFile) {
        try {
          fs.mkdirp(dirname(resolvedPlan.unitPath));
          if (fs.isSymbolicLink(resolvedPlan.unitPath)) {
            throw new Error("refusing to replace a symlinked service unit");
          }
          const windowsUserId = resolvedPlan.manager === "schtasks" ? await resolveWindowsUserId() : null;
          fs.writeFile(resolvedPlan.unitPath, renderUnit(resolvedPlan, process.env, windowsUserId));
        } catch (error) {
          return {
            ok: false,
            message: `Could not write hive unit file at ${resolvedPlan.unitPath}: ${error instanceof Error ? error.message : "unknown error"}.`
          };
        }
      }

      const { allOk, firstFailure } = await runAll(runner, installCommands(resolvedPlan, uid), {
        // Windows schtasks install is idempotent: `/Create` can succeed while `/Run` reports the
        // task is already running. Keep that benign follow-up from flipping install to exit 1.
        isNonFatalFailure: (command, result) => isBenignInstallFailure(resolvedPlan, command, result)
      });
      if (!allOk) {
        return {
          ok: false,
          message: `Registered hive unit but a service-manager command failed (${firstFailure?.command ?? "unknown"}).`
        };
      }

      return {
        ok: true,
        message: `hive registered as a ${scopePhrase(resolvedPlan)} service and started. It will restart on crash and start on boot/login.`
      };
    },

    async start(): Promise<ServiceResult> {
      let resolvedPlan: ServicePlan;
      try {
        resolvedPlan = withResolvedUnitPath(plan());
        if (!(await isCurrentRegisteredForPlan(resolvedPlan))) {
          return {
            ok: false,
            message: "hive service is not installed; run 'hive service-install' first."
          };
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not start hive service: ${error instanceof Error ? error.message : "unknown error"}.`
        };
      }

      const { allOk, firstFailure, firstFailureResult } = await runAll(
        runner,
        startCommands(resolvedPlan, uid),
        { isNonFatalFailure: (_command, result) => isAlreadyRunningTaskFailure(result) }
      );
      if (!allOk) {
        return {
          ok: false,
          message: `A service-manager start command (${firstFailure?.command ?? "unknown"}) reported an error: ${describeFailure(firstFailureResult)}.`
        };
      }
      return { ok: true, message: `hive service started (${scopePhrase(resolvedPlan)}).` };
    },

    async stop(): Promise<ServiceResult> {
      let resolvedPlan: ServicePlan;
      try {
        resolvedPlan = withResolvedUnitPath(plan());
      } catch (error) {
        return {
          ok: false,
          message: `Could not stop hive service: ${error instanceof Error ? error.message : "unknown error"}.`
        };
      }

      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, stopCommands(resolvedPlan, uid));
      if (!allOk) {
        // M-2 posture applied to stop too: a manager reporting "already not running/
        // loaded" (e.g. a repeat `hive stop`, or launchd having nothing left to boot
        // out) is a friendly no-op, not a failure - there is nothing left to stop
        // either way. A genuine failure still fails honestly with the real detail.
        if (isAlreadyAbsentFailure(resolvedPlan.manager, firstFailureResult)) {
          return {
            ok: true,
            message: `hive service was already stopped (${scopePhrase(resolvedPlan)}).`
          };
        }
        return {
          ok: false,
          message: `A service-manager stop command (${firstFailure?.command ?? "unknown"}) reported an error: ${describeFailure(firstFailureResult)}.`
        };
      }

      return {
        ok: true,
        message: `hive service stopped (${scopePhrase(resolvedPlan)}).`
      };
    },

    async uninstall(): Promise<ServiceUninstallResult> {
      let resolvedPlan: ServicePlan;
      try {
        resolvedPlan = withResolvedUnitPath(plan());
      } catch (error) {
        return {
          ok: false,
          alreadyAbsent: false,
          message: `Could not unregister hive service: ${error instanceof Error ? error.message : "unknown error"}.`
        };
      }

      // Legacy deregister is best-effort (same posture as install()): it is EXPECTED to fail
      // when no pre-decision-#32 unit exists, so it must never fail the uninstall verdict.
      // Only a current-unit deregister failure may flip `ok` to false.
      await runAll(runner, legacyUninstallCommands(resolvedPlan, uid));
      const { allOk, firstFailure, firstFailureResult } = await runAll(runner, uninstallCommands(resolvedPlan, uid));
      try {
        if (resolvedPlan.unitPath !== "") fs.removeFile(resolvedPlan.unitPath);
        const legacyPath = legacyUnitPath(resolvedPlan);
        if (legacyPath !== "") fs.removeFile(legacyPath);
      } catch {
        // A stale unit file should not block uninstall feedback.
      }

      if (!allOk) {
        // M-2: on macOS, `uninstall` runs stop (launchd `bootout`) before this current-unit
        // `bootout`, so the unit is routinely already gone by the time this call runs - that
        // is a friendly no-op (b-AC-6), not a failure, and must be classified as such rather
        // than flipping the whole verb to exit 1 despite complete success (AC-9). A GENUINE
        // failure (permission denied, manager unreachable, etc.) still fails honestly with
        // the underlying error surfaced.
        if (isAlreadyAbsentFailure(resolvedPlan.manager, firstFailureResult)) {
          return {
            ok: false,
            alreadyAbsent: true,
            message: `hive ${resolvedPlan.manager} unit was already absent (nothing to remove).`
          };
        }
        return {
          ok: false,
          alreadyAbsent: false,
          message: `Removed hive unit file; a deregister command (${firstFailure?.command ?? "unknown"}) reported an error: ${describeFailure(firstFailureResult)}.`
        };
      }

      return {
        ok: true,
        alreadyAbsent: false,
        message: `hive service unregistered (${scopePhrase(resolvedPlan)}). It will not start on next boot/login.`
      };
    }
  };
}

export { resolveServiceContext, resolveServicePlan } from "./platform.js";
export type { ServiceEnvironment, ServicePlan } from "./platform.js";
