/**
 * PRD-009a: the argv-safe child-process seam (is-AC-6).
 *
 * Every npm invocation and every product registration verb runs through {@link SpawnFn}, whose
 * signature is structurally injection-proof: the command and its arguments are ALWAYS an argv
 * array, so there is no code path that can concatenate request-derived data into a shell string.
 * The default node implementation ({@link createNodeSpawn}) passes `shell: false` explicitly.
 *
 * Windows footgun this design side-steps: `npm.cmd` cannot be spawned with `shell:false` on
 * Node >= 20 (EINVAL). Callers therefore never spawn a `.cmd`; they spawn `process.execPath`
 * with a resolved `*.js` entry as the first argv element (see `bin-resolver.ts`), so no `.cmd`
 * and no shell is ever involved.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { delimiter, dirname } from "node:path";

/** The bounded tail we keep of each stream (is-AC-17: a bounded stderr excerpt, ~2 KB). */
export const SPAWN_TAIL_LIMIT = 2048;

/** The terminal outcome of a spawned process: its exit code plus bounded stdout/stderr tails. */
export interface SpawnOutcome {
  /** The process exit code, or `null` when it was terminated by a signal without a code. */
  readonly code: number | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/** Optional streaming hooks + an abort signal for a single spawn. */
export interface SpawnInvocationOptions {
  readonly signal?: AbortSignal;
  /** Called for each stdout chunk (used to derive observable stage milestones, is-AC-12). */
  readonly onStdout?: (chunk: string) => void;
  /** Called for each stderr chunk. */
  readonly onStderr?: (chunk: string) => void;
}

/**
 * The injectable spawn surface. `command` + `args` are an argv array by construction; a shell
 * string is not expressible. Resolves with the terminal {@link SpawnOutcome}; rejects only on a
 * spawn-level error (ENOENT, EINVAL), which callers translate into a `failed` stage.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnInvocationOptions
) => Promise<SpawnOutcome>;

/** The low-level node spawn seam, injected by tests to assert `shell:false` + the argv array. */
export type RawSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly shell: false; readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv }
) => ChildProcess;

/**
 * The child env: the daemon's env with the SPAWNED BINARY's directory prepended to PATH. Under a
 * service manager (launchd/systemd) the daemon inherits a minimal PATH without node's bin dir,
 * and npm >= 9 no longer prepends node's directory when running lifecycle scripts — so a package
 * postinstall invoking plain `node` dies with `sh: node: command not found` (exit 127). The
 * command here is always `process.execPath`, so prepending its dir puts the RIGHT node first.
 */
function childEnv(command: string): NodeJS.ProcessEnv {
  const basePath = process.env.PATH ?? "";
  return { ...process.env, PATH: `${dirname(command)}${delimiter}${basePath}` };
}

/** Keep only the last `limit` characters of `current + chunk` so a chatty child cannot grow memory. */
function appendTail(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Build the default {@link SpawnFn} over node's `child_process.spawn`, pinned to `shell: false`.
 * A test injects `rawSpawn` to assert the argv array and the disabled shell without touching a
 * real process.
 */
export function createNodeSpawn(rawSpawn: RawSpawn = nodeSpawn as unknown as RawSpawn): SpawnFn {
  return (command, args, options = {}) =>
    new Promise<SpawnOutcome>((resolve, reject) => {
      let stdoutTail = "";
      let stderrTail = "";

      // The whole point of is-AC-6: an argv array and `shell: false`, never a shell string.
      const child = rawSpawn(command, [...args], { shell: false, signal: options.signal, env: childEnv(command) });

      child.stdout?.on("data", (data: unknown) => {
        const chunk = String(data);
        stdoutTail = appendTail(stdoutTail, chunk, SPAWN_TAIL_LIMIT);
        options.onStdout?.(chunk);
      });
      child.stderr?.on("data", (data: unknown) => {
        const chunk = String(data);
        stderrTail = appendTail(stderrTail, chunk, SPAWN_TAIL_LIMIT);
        options.onStderr?.(chunk);
      });
      child.on("error", (error: Error) => {
        reject(error);
      });
      child.on("close", (code: number | null) => {
        resolve({ code, stdoutTail, stderrTail });
      });
    });
}
