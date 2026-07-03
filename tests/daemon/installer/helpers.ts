/**
 * Shared harness for the PRD-009a installer suites. Every seam is faked so no test touches the
 * network, real npm, or the real filesystem (mirroring how `tests/daemon/*` inject a `FetchImpl`).
 */

import { Hono } from "hono";
import { join } from "node:path";

import {
  createInstallerService,
  type InstallerService,
  type InstallerServiceOptions
} from "../../../src/daemon/installer/index.js";
import { globalNodeModulesDir } from "../../../src/daemon/installer/bin-resolver.js";
import type { SpawnFn, SpawnOutcome } from "../../../src/daemon/installer/spawn.js";

export const TOKEN = "onboard-secret-abc123";
export const TOKEN_PATH = "/fake/home/.honeycomb/hive/onboarding-token";
export const NPM_PREFIX = "/fake/global-prefix";
export const NPM_CLI = "/fake/npm/bin/npm-cli.js";
export const FAKE_NODE = "/fake/node";
export const HIVE_HOST = "127.0.0.1:3853";
export const HIVE_ORIGIN = "http://127.0.0.1:3853";

/** The default in-memory fleet manifest returned by the fake manifest fetch. */
export const DEFAULT_MANIFEST = {
  manifestVersion: "0.2.1",
  products: {
    honeycomb: { version: "0.2.1", packageName: "@legioncodeinc/honeycomb", published: true },
    doctor: { version: "0.2.1", packageName: "@legioncodeinc/doctor", published: true },
    hive: { version: "0.2.1", packageName: "@legioncodeinc/hive", published: true },
    nectar: { version: "0.1.1", packageName: "@legioncodeinc/nectar", published: true }
  }
} as const;

/** A terminal spawn outcome (exit 0 by default). */
export function outcome(code: number, stderrTail = "", stdoutTail = ""): SpawnOutcome {
  return { code, stdoutTail, stderrTail };
}

/** A minimal manually-resolvable promise, for pausing a fake spawn mid-install. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** Build a fake {@link SpawnFn} whose per-invocation behavior is scripted by `script`. */
export function scriptedSpawn(script: (index: number, call: SpawnCall) => Promise<SpawnOutcome>): {
  readonly fn: SpawnFn;
  readonly calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fn: SpawnFn = (command, args) => {
    const call: SpawnCall = { command, args: [...args] };
    calls.push(call);
    return script(calls.length - 1, call);
  };
  return { fn, calls };
}

/** A spawn that always succeeds (exit 0) for every invocation. */
export function alwaysOkSpawn(): { readonly fn: SpawnFn; readonly calls: SpawnCall[] } {
  return scriptedSpawn(() => Promise.resolve(outcome(0)));
}

/** The global node_modules package.json key for a package, matching what the resolver reads. */
export function pkgJsonKey(packageName: string): string {
  return join(globalNodeModulesDir(NPM_PREFIX, process.platform), packageName, "package.json");
}

/** The resolved bin-entry key for a package's `dist/cli.js`, matching what the resolver checks. */
export function binEntryKey(packageName: string): string {
  return join(globalNodeModulesDir(NPM_PREFIX, process.platform), packageName, "dist/cli.js");
}

export interface HarnessOptions {
  /** Extra installer-service overrides merged last (e.g. a custom manifestFetch or spawn). */
  readonly overrides?: InstallerServiceOptions;
  /** Seed the fake filesystem with these path -> contents entries. */
  readonly files?: Record<string, string>;
  /** When true, do NOT seed the token file (simulates a completed/never-started session). */
  readonly noToken?: boolean;
}

export interface Harness {
  readonly app: Hono;
  readonly service: InstallerService;
  readonly files: Map<string, string>;
  readonly spawnCalls: SpawnCall[];
}

/**
 * Build a bare Hono app with the installer registered over fully-faked seams. `overrides.spawn` and
 * `overrides.manifestFetch` win over the defaults, so a suite can script child processes or the
 * manifest without re-specifying the rest.
 */
export function makeHarness(options: HarnessOptions = {}): Harness {
  const files = new Map<string, string>();
  if (!options.noToken) files.set(TOKEN_PATH, TOKEN);
  for (const [path, contents] of Object.entries(options.files ?? {})) files.set(path, contents);

  const defaultSpawn = alwaysOkSpawn();

  const baseOptions: InstallerServiceOptions = {
    tokenPath: TOKEN_PATH,
    fileExists: (path) => files.has(path),
    readTextFile: (path) => files.get(path) ?? null,
    deleteFile: (path) => {
      files.delete(path);
    },
    resolveNpmPrefix: async () => NPM_PREFIX,
    platform: process.platform,
    spawn: defaultSpawn.fn,
    requireResolve: (specifier) => (specifier === "npm/bin/npm-cli.js" ? NPM_CLI : null),
    execPath: FAKE_NODE,
    hiveVersion: "0.2.1",
    now: () => 0,
    manifestFetch: async () =>
      new Response(JSON.stringify(DEFAULT_MANIFEST), { status: 200, headers: { "content-type": "application/json" } })
  };

  const service = createInstallerService({ ...baseOptions, ...options.overrides });
  const app = new Hono();
  service.register(app);

  // If a custom spawn was supplied, expose ITS calls; otherwise the default's.
  const spawnCalls = options.overrides?.spawn ? [] : defaultSpawn.calls;
  return { app, service, files, spawnCalls };
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /** Override the token header; `null` omits it entirely. */
  readonly token?: string | null;
  /** Override the Host header (default the portal host). */
  readonly host?: string;
  /** Override the Origin header; `null` omits it entirely. */
  readonly origin?: string | null;
}

/** Issue an installer request with sane default portal Host/Origin/token headers. */
export function request(app: Hono, path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { host: options.host ?? HIVE_HOST };
  if (options.origin !== null) headers.origin = options.origin ?? HIVE_ORIGIN;
  if (options.token !== null) headers["x-onboarding-token"] = options.token ?? TOKEN;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  return app.request(`http://${headers.host}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });
}

/** Let queued microtasks + timers drain (lets a launched install advance to its next await). */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
