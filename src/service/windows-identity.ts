import { execFile } from "node:child_process";
import { join } from "node:path";

/** Matches a Windows SID string such as `S-1-5-21-...-1001`. */
export const WINDOWS_SID_PATTERN = /^S-1-\d+(-\d+)+$/;

export interface WhoamiResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/** Injectable seam over the `whoami.exe` invocation (hermetic tests mirror production env). */
export type WhoamiRunner = (executable: string, args: readonly string[]) => Promise<WhoamiResult>;

/** Injectable seams for Windows identity resolution (hermetic tests mirror production env). */
export interface WindowsUserIdResolverDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly runWhoami?: WhoamiRunner;
}

/**
 * Resolves `whoami.exe` under `%SystemRoot%\System32` explicitly (never bare `whoami`
 * on PATH), so a git-bash `whoami` shadowing the real binary on some machines can never
 * be picked up instead.
 */
export function whoamiExecutablePath(env: NodeJS.ProcessEnv): string {
  return join(env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
}

/** Real `whoami.exe` runner: execFile, never a shell. */
export function createExecFileWhoamiRunner(): WhoamiRunner {
  return (executable, args) =>
    new Promise((resolve) => {
      execFile(executable, [...args], (error, stdout) => {
        resolve({ ok: error === null, stdout });
      });
    });
}

/**
 * Parses the SID out of `whoami /user /fo csv /nh` output, e.g.
 * `"domain\user","S-1-5-21-...-1001"`. Takes the last non-empty line (defensive
 * against a stray header row) and the last CSV field, strips surrounding quotes,
 * and validates the shape. Returns `null` on anything that does not look like a SID.
 */
export function parseWhoamiSid(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .pop();
  if (line === undefined) return null;

  const fields = line.split(",");
  const rawLast = fields[fields.length - 1];
  if (rawLast === undefined) return null;

  const sid = rawLast.trim().replace(/^"/, "").replace(/"$/, "");
  return WINDOWS_SID_PATTERN.test(sid) ? sid : null;
}

/** `${USERDOMAIN}\${USERNAME}`, or `null` when either is unset/empty. */
export function fallbackWindowsAccount(env: NodeJS.ProcessEnv): string | null {
  const domain = env.USERDOMAIN;
  const user = env.USERNAME;
  if (domain === undefined || domain === "" || user === undefined || user === "") return null;
  return `${domain}\\${user}`;
}

/**
 * Resolves the value to embed as the schtasks `LogonTrigger`/`Principal` `UserId`.
 *
 * On a hardened Windows 11 25H2 machine (Administrator Protection enabled), an
 * unscoped `LogonTrigger`/`Principal` (no `UserId`, meaning "any user's logon") is
 * exactly what makes `schtasks /Create` refuse registration from a non-elevated
 * shell with "ERROR: Access is denied." Scoping both elements to a concrete
 * identity is the fix.
 *
 * Resolution order: the current user's SID via `whoami.exe /user /fo csv /nh`
 * (execFile, never a shell); falling back to `${USERDOMAIN}\${USERNAME}` when the
 * SID cannot be determined; falling back to `null` (render with no `UserId`,
 * today's unscoped behavior) when neither is available, so non-hardened machines
 * keep working unchanged.
 */
export async function resolveWindowsUserId(deps: WindowsUserIdResolverDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const runWhoami = deps.runWhoami ?? createExecFileWhoamiRunner();

  const result = await runWhoami(whoamiExecutablePath(env), ["/user", "/fo", "csv", "/nh"]);
  if (result.ok) {
    const sid = parseWhoamiSid(result.stdout);
    if (sid !== null) return sid;
  }

  return fallbackWindowsAccount(env);
}
