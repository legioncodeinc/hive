import { z } from "zod";

import { resolveFleetRegistryPath } from "../shared/apiary-root.js";
import { readRegistryBody } from "../shared/registry-paths.js";
import { isLoopbackBaseUrl, normalizeDaemonBases, type DaemonBases, type DaemonName } from "../shared/daemon-routing.js";

/**
 * Informational only: the fleet-root registry location snapshotted at module load. Readers must
 * go through {@link readRegistryBody} (which applies the new-then-legacy window chain per call),
 * never read this constant's path directly.
 */
export const DOCTOR_REGISTRY_PATH = resolveFleetRegistryPath();

const RegistryEntrySchema = z.object({
  name: z.string().min(1),
  healthUrl: z.string().url(),
  pidPath: z.string().min(1)
});

const DoctorRegistrySchema = z.object({
  daemons: z.array(RegistryEntrySchema).catch([])
});

export interface ResolveDaemonBasesOptions {
  readonly registryPath?: string;
  readonly readFile?: (path: string) => string;
}

function daemonName(name: string): DaemonName | null {
  if (name === "honeycomb" || name === "nectar") return name;
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

export function parseDoctorRegistry(raw: string): Partial<Record<DaemonName, string>> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // A corrupt registry must not prevent hive from serving. Defaults remain available.
    return {};
  }

  const parsed = DoctorRegistrySchema.safeParse(parsedJson);
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
 * Parse the RAW list of registered service names from a doctor registry file body (PRD-004a
 * bz-AC-1/bz-AC-2). Unlike {@link parseDoctorRegistry} (which narrows to the two daemons
 * hive's BFF proxy forwards to, `honeycomb`/`nectar`), this returns EVERY registered name —
 * including `hive` itself or any future peer — so `/buzzing` and the health rail can render one
 * tile/pill per service that doctor says should exist, even one hive's proxy never routes
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

  const parsed = DoctorRegistrySchema.safeParse(parsedJson);
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
 * Read the FULL list of registered service names from doctor's registry file (PRD-004a
 * bz-AC-1/bz-AC-2, PRD-005a hr-AC-1). A missing/unreadable/corrupt registry resolves to an empty
 * list rather than throwing, so a cold box with no registry yet still serves `/buzzing` (it simply
 * shows no tiles until the fleet-status/SSE feed enumerates services some other way).
 */
export function resolveRegisteredServiceNames(options: ResolveRegisteredServiceNamesOptions = {}): readonly string[] {
  const raw = readRegistryBody(options);
  if (raw === null) return [];
  return parseRegisteredServiceNames(raw);
}

export function resolveDaemonBases(options: ResolveDaemonBasesOptions = {}): DaemonBases {
  const raw = readRegistryBody(options);
  if (raw === null) {
    // Missing or unreadable registry means no daemon has registered yet. Use documented loopback defaults.
    return normalizeDaemonBases();
  }

  return normalizeDaemonBases(parseDoctorRegistry(raw));
}

export { readRegistryBody } from "../shared/registry-paths.js";
