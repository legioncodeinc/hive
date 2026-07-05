import { existsSync, lstatSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { resolveFleetRoot, resolveHiveStateDir, type FleetRootDeps } from "../shared/apiary-root.js";

export interface StateDirFs {
  exists(path: string): boolean;
  lstat(path: string): { readonly isSymbolicLink: () => boolean };
  removeDir(path: string): void;
}

export function createNodeStateDirFs(): StateDirFs {
  return {
    exists(path: string): boolean {
      return existsSync(path);
    },
    lstat(path: string) {
      return lstatSync(path);
    },
    removeDir(path: string): void {
      rmSync(path, { recursive: true, force: true });
    }
  };
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedRoot = resolve(rootPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function removeHiveStateDir(deps: FleetRootDeps = {}, fs: StateDirFs = createNodeStateDirFs()): boolean {
  const fleetRoot = resolveFleetRoot(deps);
  const stateDir = resolveHiveStateDir(deps);

  if (!isPathWithinRoot(stateDir, fleetRoot)) {
    throw new Error(`Refusing to remove hive state dir outside the fleet root: ${stateDir}`);
  }

  if (!fs.exists(stateDir)) return false;
  if (fs.lstat(stateDir).isSymbolicLink()) {
    throw new Error(`Refusing to remove hive state dir because it is a symlink: ${stateDir}`);
  }

  fs.removeDir(stateDir);
  return true;
}

export function hiveStateDirExists(deps: FleetRootDeps = {}, fs: StateDirFs = createNodeStateDirFs()): boolean {
  return fs.exists(resolveHiveStateDir(deps));
}
