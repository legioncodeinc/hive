import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "hive-packed-cli-"));
const npmCli = process.env.npm_execpath;
let tarball;

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, APIARY_HOME: join(temp, "apiary"), ...options.env },
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function invoke(args, expectedStatus = 0, env = {}) {
  const result = run(process.execPath, [packedCli, ...args], { env });
  assert(result.status === expectedStatus, `${args.join(" ") || "<bare>"}: expected ${expectedStatus}, got ${result.status}\n${result.stderr}`);
  return result;
}

let packedCli;
try {
  assert(npmCli !== undefined, "npm_execpath is required; run via npm run test:packed-cli");
  const packed = run(process.execPath, [npmCli, "pack", "--silent"]);
  assert(packed.status === 0, `npm pack failed: ${packed.error?.message ?? packed.stderr}`);
  const filename = packed.stdout.trim().split(/\r?\n/).at(-1);
  assert(filename?.endsWith(".tgz"), `npm pack did not return a tarball: ${packed.stdout}`);
  tarball = join(root, basename(filename));

  const installed = run(process.execPath, [npmCli,
    "install", "--prefix", temp, tarball, "--ignore-scripts", "--silent"
  ]);
  assert(installed.status === 0, `packed install failed: ${installed.stderr}`);
  packedCli = join(temp, "node_modules", "@legioncodeinc", "hive", "dist", "cli.js");

  const bare = invoke([]).stdout;
  const help = invoke(["--help"]).stdout;
  assert(bare === help, "bare invocation and --help diverged");
  for (const required of [
    "HIVE", "Legion Code Inc. x Activeloop", "start", "stop", "restart", "install", "uninstall",
    "service-install", "service-uninstall", "update", "status", "register", "logs", "telemetry", "daemon"
  ]) assert(help.includes(required), `packed help missing ${required}`);
  assert(!help.includes("  install-service"), "deprecated install-service alias leaked into primary help");

  assert(invoke(["--version"]).stdout === `hive v${packageJson.version}\n`, "packed text version mismatch");
  const versionJson = JSON.parse(invoke(["--version", "--json"]).stdout);
  assert(versionJson.version === packageJson.version && versionJson.ok === true, "packed JSON version mismatch");

  const helpJsonText = invoke(["--help", "--json"]).stdout;
  const helpJson = JSON.parse(helpJsonText);
  assert(helpJson.product === "hive" && helpJson.command === "help", "packed JSON help envelope mismatch");
  assert(!helpJsonText.includes("Legion Code Inc."), "JSON help contains attribution prose");
  assert(!/\u001b/.test(helpJsonText), "JSON help contains ANSI");

  const unknown = JSON.parse(invoke(["not-a-command", "--json"], 2).stdout);
  assert(unknown.ok === false && unknown.command === "not-a-command", "packed unknown-command contract mismatch");

  invoke(["status"]);
  JSON.parse(invoke(["status", "--json"]).stdout);
  invoke(["telemetry"], 0, { HONEYCOMB_TELEMETRY: "0" });
  const telemetry = JSON.parse(invoke(["telemetry", "--json"], 0, { HONEYCOMB_TELEMETRY: "0" }).stdout);
  assert(telemetry.details.telemetry.state === "opted-out", "packed telemetry opt-out mismatch");
  invoke(["logs", "--no-follow"], 1);
  const missingLog = JSON.parse(invoke(["logs", "--no-follow", "--json"], 1).stdout);
  assert(missingLog.ok === false && missingLog.command === "logs", "packed missing-log JSON mismatch");

  process.stdout.write("Packed Hive CLI conformance passed.\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
  if (tarball !== undefined) rmSync(tarball, { force: true });
}
