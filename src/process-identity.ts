import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function normalized(value: string): string {
  const path = resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function argvIdentifiesHive(argv: readonly string[], cliEntryPath: string): boolean {
  const expected = normalized(cliEntryPath);
  return argv.some((argument, index) =>
    normalized(argument) === expected && argv[index + 1] === "daemon"
  );
}

export function commandLineIdentifiesHive(commandLine: string, cliEntryPath: string): boolean {
  return argvIdentifiesHive(parseProcessCommandLine(commandLine), cliEntryPath);
}

export function parseProcessCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index];
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      if (current !== "") {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current !== "") argv.push(current);
  return argv;
}

function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(command, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolveResult(stdout);
    });
  });
}

/** Fail-closed process identity check used before signaling a PID read from Hive state. */
export async function isHiveCliProcess(pid: number, cliEntryPath: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === "linux") {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return argvIdentifiesHive(raw.split("\0").filter(Boolean), cliEntryPath);
    }
    if (process.platform === "win32") {
      const script =
        `$p=Get-CimInstance Win32_Process|Where-Object -Property ProcessId -EQ ${pid};` +
        `if($null -eq $p){exit 1};` +
        `Write-Output $p.CommandLine`;
      const commandLine = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      return commandLineIdentifiesHive(commandLine, cliEntryPath);
    }
    const commandLine = await execFileText("ps", ["-p", String(pid), "-o", "command="]);
    return commandLineIdentifiesHive(commandLine, cliEntryPath);
  } catch {
    return false;
  }
}
