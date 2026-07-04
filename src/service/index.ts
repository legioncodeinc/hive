import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveStagedWindowsTaskPath } from "../shared/apiary-root.js";
import { migrateHiveState } from "../shared/state-migration.js";
import { installCommands, legacyUninstallCommands, uninstallCommands, type ServiceCommand } from "./commands.js";
import {
  legacyUnitPath,
  resolveServiceContext,
  resolveServicePlan,
  type ServiceEnvironment,
  type ServicePlan
} from "./platform.js";
import { renderUnit } from "./templates.js";

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
}

export interface ServiceResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface ServiceModule {
  install(): Promise<ServiceResult>;
  uninstall(): Promise<ServiceResult>;
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
      writeFileSync(path, content, "utf8");
    },
    removeFile(path: string): void {
      rmSync(path, { force: true });
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
  commands: readonly ServiceCommand[]
): Promise<{ readonly allOk: boolean; readonly firstFailure: ServiceCommand | null }> {
  let firstFailure: ServiceCommand | null = null;
  for (const command of commands) {
    const result = await runner.run(command.command, command.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
    if (!result.ok && firstFailure === null) {
      firstFailure = command;
    }
  }
  return { allOk: firstFailure === null, firstFailure };
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

  function plan(): ServicePlan {
    return resolveServicePlan(environment);
  }

  return {
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
          fs.writeFile(resolvedPlan.unitPath, renderUnit(resolvedPlan));
        } catch (error) {
          return {
            ok: false,
            message: `Could not write hive unit file at ${resolvedPlan.unitPath}: ${error instanceof Error ? error.message : "unknown error"}.`
          };
        }
      }

      const { allOk, firstFailure } = await runAll(runner, installCommands(resolvedPlan, uid));
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

    async uninstall(): Promise<ServiceResult> {
      let resolvedPlan: ServicePlan;
      try {
        resolvedPlan = withResolvedUnitPath(plan());
      } catch (error) {
        return {
          ok: false,
          message: `Could not unregister hive service: ${error instanceof Error ? error.message : "unknown error"}.`
        };
      }

      const { allOk, firstFailure } = await runAll(runner, uninstallCommands(resolvedPlan, uid));
      try {
        if (resolvedPlan.unitPath !== "") fs.removeFile(resolvedPlan.unitPath);
      } catch {
        // A stale unit file should not block uninstall feedback.
      }

      if (!allOk) {
        return {
          ok: false,
          message: `Removed hive unit file; a deregister command (${firstFailure?.command ?? "unknown"}) reported an error.`
        };
      }

      return {
        ok: true,
        message: `hive service unregistered (${scopePhrase(resolvedPlan)}). It will not start on next boot/login.`
      };
    }
  };
}

export { resolveServiceContext, resolveServicePlan } from "./platform.js";
export type { ServiceEnvironment, ServicePlan } from "./platform.js";
