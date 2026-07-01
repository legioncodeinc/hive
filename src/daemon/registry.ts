import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { HONEYCOMB_HOME_DIR } from "../shared/constants.js";
import { isLoopbackBaseUrl, normalizeDaemonBases, type DaemonBases, type DaemonName } from "../shared/daemon-routing.js";

export const HIVEDOCTOR_REGISTRY_PATH = join(HONEYCOMB_HOME_DIR, "hivedoctor.daemons.json");

const RegistryEntrySchema = z.object({
  name: z.string().min(1),
  healthUrl: z.string().url(),
  pidPath: z.string().min(1)
});

const HivedoctorRegistrySchema = z.object({
  daemons: z.array(RegistryEntrySchema).catch([])
});

export interface ResolveDaemonBasesOptions {
  readonly registryPath?: string;
  readonly readFile?: (path: string) => string;
}

function daemonName(name: string): DaemonName | null {
  if (name === "honeycomb" || name === "hivenectar") return name;
  return null;
}

export function baseUrlFromHealthUrl(healthUrl: string): string | null {
  try {
    const url = new URL(healthUrl);
    // Reject any registry entry naming a non-loopback host BEFORE it can become a daemon base:
    // every workload daemon binds loopback only, so a `healthUrl` pointing elsewhere is either a
    // corrupt registry or a tampered one, and must never become a base the server-side proxy
    // (`src/daemon/proxy.ts`) would forward request bodies (including captured session/memory
    // content) to.
    if (!isLoopbackBaseUrl(url.origin)) return null;
    const pathname = url.pathname.endsWith("/health") ? url.pathname.slice(0, -"/health".length) : url.pathname;
    const normalizedPath = pathname === "/" ? "" : pathname.replace(/\/$/, "");
    return `${url.origin}${normalizedPath}`;
  } catch {
    // zod normally rejects invalid URLs first; this keeps the exported helper total for tests and callers.
    return null;
  }
}

export function parseHivedoctorRegistry(raw: string): Partial<Record<DaemonName, string>> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // A corrupt registry must not prevent thehive from serving. Defaults remain available.
    return {};
  }

  const parsed = HivedoctorRegistrySchema.safeParse(parsedJson);
  if (!parsed.success) return {};

  const bases: Partial<Record<DaemonName, string>> = {};
  for (const entry of parsed.data.daemons) {
    const name = daemonName(entry.name);
    if (name === null) continue;
    const baseUrl = baseUrlFromHealthUrl(entry.healthUrl);
    if (baseUrl !== null) bases[name] = baseUrl;
  }
  return bases;
}

/**
 * Parse the RAW list of registered service names from a hivedoctor registry file body (PRD-004a
 * bz-AC-1/bz-AC-2). Unlike {@link parseHivedoctorRegistry} (which narrows to the two daemons
 * thehive's BFF proxy forwards to, `honeycomb`/`hivenectar`), this returns EVERY registered name —
 * including `thehive` itself or any future peer — so `/buzzing` and the health rail can render one
 * tile/pill per service that hivedoctor says should exist, even one thehive's proxy never routes
 * to. A corrupt/absent registry degrades to an empty list (never a throw), matching every other
 * reader of this file.
 */
export function parseRegisteredServiceNames(raw: string): readonly string[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return [];
  }

  const parsed = HivedoctorRegistrySchema.safeParse(parsedJson);
  if (!parsed.success) return [];

  // De-duplicate defensively (a hand-edited registry could repeat a name); preserve first-seen order.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of parsed.data.daemons) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    names.push(entry.name);
  }
  return names;
}

/** Options for {@link resolveRegisteredServiceNames}. */
export interface ResolveRegisteredServiceNamesOptions {
  readonly registryPath?: string;
  readonly readFile?: (path: string) => string;
}

/**
 * Read the FULL list of registered service names from hivedoctor's registry file (PRD-004a
 * bz-AC-1/bz-AC-2, PRD-005a hr-AC-1). A missing/unreadable/corrupt registry resolves to an empty
 * list rather than throwing, so a cold box with no registry yet still serves `/buzzing` (it simply
 * shows no tiles until the fleet-status/SSE feed enumerates services some other way).
 */
export function resolveRegisteredServiceNames(options: ResolveRegisteredServiceNamesOptions = {}): readonly string[] {
  const registryPath = options.registryPath ?? HIVEDOCTOR_REGISTRY_PATH;
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));

  try {
    return parseRegisteredServiceNames(readFile(registryPath));
  } catch {
    return [];
  }
}

export function resolveDaemonBases(options: ResolveDaemonBasesOptions = {}): DaemonBases {
  const registryPath = options.registryPath ?? HIVEDOCTOR_REGISTRY_PATH;
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));

  try {
    return normalizeDaemonBases(parseHivedoctorRegistry(readFile(registryPath)));
  } catch {
    // Missing or unreadable registry means no daemon has registered yet. Use documented loopback defaults.
    return normalizeDaemonBases();
  }
}
