import { validateManifest } from "@legioncodeinc/cli-kit";

import { HIVE_MANIFEST, renderHiveHelp, runHiveCli } from "../src/cli-interface.js";
import { HIVE_VERSION } from "../src/shared/constants.js";

function capture(): { readonly lines: string[]; readonly write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text) => lines.push(text) };
}

describe("Hive CLI contract", () => {
  it("publishes the complete canonical command manifest", () => {
    expect(HIVE_MANIFEST.commands.map(({ name }) => name)).toEqual([
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "install",
      "uninstall",
      "service-install",
      "service-uninstall",
      "update",
      "register",
      "telemetry",
      "daemon"
    ]);
    expect(validateManifest(HIVE_MANIFEST)).toEqual([]);
  });

  it("renders product-specific ASCII branding, uppercase name, credit, groups, and global flags", () => {
    const help = renderHiveHelp(80);
    expect(help).toContain("  /\\_/\\");
    expect(help).toContain("\nHIVE\n");
    expect(help).toContain("Legion Code Inc. x Activeloop");
    expect(help).toContain("Usage: hive <command> [options]");
    expect(help).toContain("Service lifecycle");
    expect(help).toContain("Installation");
    expect(help).toContain("Fleet");
    expect(help).toContain("Diagnostics");
    expect(help).toContain("Product commands");
    expect(help).toContain("--help, -h");
    expect(help).toContain("--version");
    expect(help).toContain("--json");
    expect(help).toContain("--no-color");
    expect(help.endsWith("\n")).toBe(true);
  });

  it("keeps 80-column, narrow, and color-disabled help text stable and ANSI-free", () => {
    const wide = renderHiveHelp(80);
    const narrow = renderHiveHelp(40);
    expect(wide).toContain(`v${HIVE_VERSION}\nLegion Code Inc. x Activeloop\n`);
    expect(narrow).toContain("Apiary colony service coordinator");
    expect(narrow.split("\n").every((line) => line.length <= 40)).toBe(true);
    expect(wide).not.toMatch(/\u001b\[/);
    expect(narrow).not.toMatch(/\u001b\[/);
  });

  it.each([[[]], [["--help"]], [["-h"]]])("returns help for %j", async (argv: string[]) => {
    const stdout = capture();
    expect(await runHiveCli(argv, "/tmp/hive.js", { stdout: stdout.write, stderr: vi.fn() })).toBe(0);
    expect(stdout.lines.join("")).toContain("HIVE");
  });

  it("emits single-source text and JSON versions", async () => {
    const textOut = capture();
    expect(await runHiveCli(["--version"], "/tmp/hive.js", { stdout: textOut.write })).toBe(0);
    expect(textOut.lines.join("")).toBe(`hive v${HIVE_VERSION}\n`);

    const jsonOut = capture();
    expect(await runHiveCli(["--version", "--json"], "/tmp/hive.js", { stdout: jsonOut.write })).toBe(0);
    expect(JSON.parse(jsonOut.lines.join(""))).toMatchObject({
      product: "hive",
      command: "version",
      ok: true,
      version: HIVE_VERSION
    });
  });

  it("emits machine-readable help with every command", async () => {
    const stdout = capture();
    expect(await runHiveCli(["--help", "--json"], "/tmp/hive.js", { stdout: stdout.write })).toBe(0);
    const body = JSON.parse(stdout.lines.join("")) as { details: { commands: Array<{ name: string }> } };
    expect(body.details.commands.map(({ name }) => name)).toEqual(HIVE_MANIFEST.commands.map(({ name }) => name));
  });

  it.each([
    ["install-service", "service-install"],
    ["uninstall-service", "service-uninstall"]
  ])("accepts deprecated alias %s, warns, and dispatches canonical %s", async (alias, canonical) => {
    const stderr = capture();
    const execute = vi.fn(async () => 0);
    expect(await runHiveCli([alias], "/tmp/hive.js", { stderr: stderr.write, execute })).toBe(0);
    expect(stderr.lines.join("")).toContain(`'${alias}' is deprecated`);
    expect(execute).toHaveBeenCalledWith(canonical, [], "/tmp/hive.js", expect.any(Function));
  });

  it("returns usage exit 2 for unknown commands and unexpected positionals", async () => {
    const stderr = capture();
    expect(await runHiveCli(["bogus"], "/tmp/hive.js", { stderr: stderr.write })).toBe(2);
    expect(stderr.lines.join("")).toContain("unknown command: bogus");

    stderr.lines.length = 0;
    expect(await runHiveCli(["start", "extra"], "/tmp/hive.js", { stderr: stderr.write })).toBe(2);
    expect(stderr.lines.join("")).toContain("does not accept positional arguments");
  });

  it("returns structured JSON for success, command failure, usage failure, and thrown runtime errors", async () => {
    const cases = [
      { argv: ["start", "--json"], execute: async () => 0, code: 0, ok: true },
      { argv: ["start", "--json"], execute: async () => 1, code: 1, ok: false },
      { argv: ["bogus", "--json"], execute: async () => 0, code: 2, ok: false },
      { argv: ["start", "--json"], execute: async () => { throw new Error("service exploded"); }, code: 1, ok: false }
    ] as const;

    for (const scenario of cases) {
      const stdout = capture();
      const code = await runHiveCli(scenario.argv, "/tmp/hive.js", {
        stdout: stdout.write,
        stderr: vi.fn(),
        execute: scenario.execute
      });
      expect(code).toBe(scenario.code);
      expect(JSON.parse(stdout.lines.join(""))).toMatchObject({ product: "hive", ok: scenario.ok });
    }
  });

  it("routes human command success to stdout and operational failure to stderr", async () => {
    const successOut = capture();
    const successErr = capture();
    expect(await runHiveCli(["start"], "/tmp/hive.js", {
      stdout: successOut.write,
      stderr: successErr.write,
      execute: async (_command, _args, _path, out) => { out("started\n"); return 0; }
    })).toBe(0);
    expect(successOut.lines.join("")).toBe("started\n");
    expect(successErr.lines.join("")).toBe("");

    const failureOut = capture();
    const failureErr = capture();
    expect(await runHiveCli(["start"], "/tmp/hive.js", {
      stdout: failureOut.write,
      stderr: failureErr.write,
      execute: async (_command, _args, _path, out) => { out("service failed\n"); return 1; }
    })).toBe(1);
    expect(failureOut.lines.join("")).toBe("");
    expect(failureErr.lines.join("")).toBe("service failed\n");
  });

  it("strips terminal controls from untrusted human command output", async () => {
    const stdout = capture();
    const stderr = capture();
    expect(await runHiveCli(["start"], "/tmp/hive.js", {
      stdout: stdout.write,
      stderr: stderr.write,
      execute: async (_command, _args, _path, out) => { out("safe\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\n"); return 1; }
    })).toBe(1);
    expect(stdout.lines.join("")).toBe("");
    expect(stderr.lines.join("")).toBe("safeclick\n");
  });

  it("requires explicit uninstall confirmation and never executes after a decline", async () => {
    const stdout = capture();
    const execute = vi.fn(async () => 0);
    const confirmRemoval = vi.fn(async () => false);
    expect(await runHiveCli(["uninstall"], "/tmp/hive.js", {
      stdout: stdout.write,
      execute,
      confirmRemoval
    })).toBe(0);
    expect(confirmRemoval).toHaveBeenCalledWith(false);
    expect(execute).not.toHaveBeenCalled();
    expect(stdout.lines.join("")).toContain("cancelled");
  });

  it("requires --yes for JSON uninstall and strips it before dispatch", async () => {
    const denied = capture();
    expect(await runHiveCli(["uninstall", "--json"], "/tmp/hive.js", {
      stdout: denied.write,
      execute: vi.fn()
    })).toBe(2);
    expect(JSON.parse(denied.lines.join(""))).toMatchObject({ ok: false, command: "uninstall" });

    const accepted = capture();
    const execute = vi.fn(async () => 0);
    const confirmRemoval = vi.fn(async () => true);
    expect(await runHiveCli(["uninstall", "--yes", "--json"], "/tmp/hive.js", {
      stdout: accepted.write,
      execute,
      confirmRemoval
    })).toBe(0);
    expect(confirmRemoval).toHaveBeenCalledWith(true);
    expect(execute).toHaveBeenCalledWith("uninstall", [], "/tmp/hive.js", expect.any(Function));
    expect(JSON.parse(accepted.lines.join(""))).toMatchObject({ ok: true, command: "uninstall" });
  });

  it("keeps status runtime failures inside the single JSON envelope", async () => {
    const stdout = capture();
    const stderr = capture();
    const service = {
      install: async () => ({ ok: true, message: "installed" }),
      start: async () => ({ ok: true, message: "started" }),
      stop: async () => ({ ok: true, message: "stopped" }),
      uninstall: async () => ({ ok: true, alreadyAbsent: false, message: "removed" }),
      isRegistered: async () => { throw new Error("status exploded"); }
    };
    expect(await runHiveCli(["status", "--json"], "/tmp/hive.js", {
      stdout: stdout.write,
      stderr: stderr.write,
      status: { service, readPid: () => null }
    })).toBe(1);
    expect(stderr.lines.join("")).toBe("");
    expect(JSON.parse(stdout.lines.join(""))).toMatchObject({
      product: "hive", command: "status", ok: false, message: "status exploded"
    });
  });
});
