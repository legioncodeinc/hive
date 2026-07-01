import type { CommandResult, CommandRunner, ServiceFs } from "../../src/service/index.js";
import type { ServiceEnvironment } from "../../src/service/platform.js";

export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RecordingRunner extends CommandRunner {
  readonly calls: RecordedCommand[];
}

export function createRecordingRunner(
  respond?: (command: string, args: readonly string[]) => CommandResult
): RecordingRunner {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    run(command: string, args: readonly string[]): Promise<CommandResult> {
      calls.push({ command, args: [...args] });
      const result = respond?.(command, args) ?? { ok: true, code: 0, stdout: "", stderr: "" };
      return Promise.resolve(result);
    }
  };
}

export interface MemoryFs extends ServiceFs {
  readonly files: Map<string, string>;
  readonly mkdirs: string[];
  readonly removed: string[];
}

export function createMemoryFs(failWrite = false): MemoryFs {
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const removed: string[] = [];

  return {
    files,
    mkdirs,
    removed,
    mkdirp(path: string): void {
      mkdirs.push(path);
    },
    writeFile(path: string, content: string): void {
      if (failWrite) throw new Error("EACCES: permission denied");
      files.set(path, content);
    },
    removeFile(path: string): void {
      removed.push(path);
      files.delete(path);
    }
  };
}

export function fixedEnv(overrides: Partial<ServiceEnvironment> & Pick<ServiceEnvironment, "platform">): ServiceEnvironment {
  return {
    platform: overrides.platform,
    home: overrides.home ?? "/home/tester",
    execPath: overrides.execPath ?? "/tmp/thehive/dist/cli.js"
  };
}
