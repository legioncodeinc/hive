import { describe, expect, it } from "vitest";

import { argvIdentifiesHive, commandLineIdentifiesHive } from "../src/process-identity.js";

describe("hive process identity", () => {
  it("accepts the exact CLI entry followed by the daemon verb", () => {
    expect(argvIdentifiesHive(["node", "/opt/hive/dist/cli.js", "daemon"], "/opt/hive/dist/cli.js")).toBe(true);
  });

  it("rejects a different executable and a non-daemon Hive command", () => {
    expect(argvIdentifiesHive(["node", "/opt/other/dist/cli.js", "daemon"], "/opt/hive/dist/cli.js")).toBe(false);
    expect(argvIdentifiesHive(["node", "/opt/hive/dist/cli.js", "status"], "/opt/hive/dist/cli.js")).toBe(false);
  });

  it("recognizes the Windows scheduled-task daemon command line", () => {
    const path = "C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\@legioncodeinc\\hive\\dist\\cli.js";
    expect(commandLineIdentifiesHive(`"C:\\Program Files\\nodejs\\node.exe" ${path} daemon`, path)).toBe(true);
  });

  it("rejects command lines where the expected path and daemon token are not adjacent", () => {
    const path = "C:\\Users\\mario\\hive\\dist\\cli.js";
    expect(commandLineIdentifiesHive(`node ${path} status --note daemon`, path)).toBe(false);
    expect(commandLineIdentifiesHive(`node other.js ${path} daemon`, path)).toBe(true);
  });
});
