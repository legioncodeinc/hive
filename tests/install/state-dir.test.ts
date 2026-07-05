import { join } from "node:path";

import { removeHiveStateDir } from "../../src/install/state-dir.js";

describe("hive state dir removal", () => {
  it("b-AC-4 removes only the resolved hive state dir under the fleet root", () => {
    const home = "/home/tester";
    const fleetRoot = join(home, ".apiary");
    const hiveStateDir = join(fleetRoot, "hive");
    const removed: string[] = [];

    const removedFlag = removeHiveStateDir(
      { home },
      {
        exists: (path) => path === hiveStateDir,
        lstat: () => ({ isSymbolicLink: () => false }),
        removeDir: (path) => {
          removed.push(path);
        }
      }
    );

    expect(removedFlag).toBe(true);
    expect(removed).toEqual([hiveStateDir]);
  });

  it("b-AC-4 refuses to remove a symlinked hive state dir", () => {
    const home = "/home/tester";
    const hiveStateDir = join(home, ".apiary", "hive");
    expect(() =>
      removeHiveStateDir(
        { home },
        {
          exists: () => true,
          lstat: () => ({ isSymbolicLink: () => true }),
          removeDir: () => {}
        }
      )
    ).toThrow("symlink");
    expect(hiveStateDir).toContain("hive");
  });
});
