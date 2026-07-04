/**
 * PRD-009a is-AC-6: the default node spawn is structurally injection-free. It passes an argv array
 * and `shell: false`; a chatty child's stream is bounded (feeding is-AC-17's bounded error excerpt).
 */

import { EventEmitter } from "node:events";

import { SPAWN_TAIL_LIMIT, createNodeSpawn, type RawSpawn } from "../../../src/daemon/installer/spawn.js";

interface FakeChildOptions {
  readonly code?: number;
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
}

function fakeChild(options: FakeChildOptions): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    for (const chunk of options.stdout ?? []) child.stdout.emit("data", Buffer.from(chunk));
    for (const chunk of options.stderr ?? []) child.stderr.emit("data", Buffer.from(chunk));
    child.emit("close", options.code ?? 0);
  });
  return child;
}

describe("createNodeSpawn", () => {
  it("is-AC-6 spawns with an argv array and shell disabled", async () => {
    let recorded: { command: string; args: readonly string[]; shell: unknown; env?: NodeJS.ProcessEnv } | null = null;
    const rawSpawn: RawSpawn = (command, args, options) => {
      recorded = { command, args: [...args], shell: options.shell, env: options.env };
      return fakeChild({ code: 0 }) as unknown as ReturnType<RawSpawn>;
    };

    const outcome = await createNodeSpawn(rawSpawn)("/path/to/node", ["npm-cli.js", "install", "-g", "@scope/pkg@1.2.3"]);

    expect(recorded).not.toBeNull();
    expect(recorded!.command).toBe("/path/to/node");
    expect(recorded!.args).toEqual(["npm-cli.js", "install", "-g", "@scope/pkg@1.2.3"]);
    expect(recorded!.shell).toBe(false);
    expect(outcome.code).toBe(0);
  });

  it("prepends the spawned binary's directory to the child PATH (lifecycle scripts need `node`)", async () => {
    let recordedEnv: NodeJS.ProcessEnv | undefined;
    const rawSpawn: RawSpawn = (_command, _args, options) => {
      recordedEnv = options.env;
      return fakeChild({ code: 0 }) as unknown as ReturnType<RawSpawn>;
    };

    await createNodeSpawn(rawSpawn)("/path/to/node", ["npm-cli.js"]);

    expect(recordedEnv).toBeDefined();
    expect(recordedEnv!.PATH!.startsWith("/path/to")).toBe(true);
  });

  it("is-AC-17 bounds the captured stderr tail so a chatty child cannot grow memory", async () => {
    const noisy = "e".repeat(5000);
    const rawSpawn: RawSpawn = () => fakeChild({ code: 1, stderr: [noisy] }) as unknown as ReturnType<RawSpawn>;

    const outcome = await createNodeSpawn(rawSpawn)("/node", []);
    expect(outcome.code).toBe(1);
    expect(outcome.stderrTail.length).toBe(SPAWN_TAIL_LIMIT);
  });

  it("streams stdout chunks to the onStdout hook", async () => {
    const rawSpawn: RawSpawn = () => fakeChild({ code: 0, stdout: ["added 1 package"] }) as unknown as ReturnType<RawSpawn>;
    const seen: string[] = [];
    const outcome = await createNodeSpawn(rawSpawn)("/node", [], { onStdout: (chunk) => seen.push(chunk) });
    expect(seen).toEqual(["added 1 package"]);
    expect(outcome.stdoutTail).toContain("added 1 package");
  });
});
