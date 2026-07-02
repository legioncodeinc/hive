/**
 * hive's SINGLE telemetry-egress chokepoint.
 *
 * `emitTelemetry(event, opts, deps?)` is the ONLY place in this package that posts to the PostHog
 * capture endpoint. The four lifecycle emit sites (install-service -> `hive_installed`,
 * uninstall-service -> `hive_uninstalled`, first `start` -> `hive_first_run`, version change on
 * `start` -> `hive_updated`) all funnel through here, so the allow-list, the opt-out gates, the
 * dedupe ledger, and the bounded fire-and-forget POST posture live in ONE module. Mirrors the posture
 * of honeycomb's `src/daemon/runtime/telemetry/emit.ts` and doctor's `src/telemetry/emit.ts`.
 *
 * Gates, in order (a return is silent; telemetry NEVER throws):
 *   1. Build-injected `__HONEYCOMB_POSTHOG_KEY__` empty -> hard-disabled (unkeyed dev build).
 *   2. `HONEYCOMB_TELEMETRY=0` or `DO_NOT_TRACK` truthy   -> opted out.
 *   3. Dedupe key already in the JSON ledger              -> already sent.
 * Only past all three does a single bounded-timeout POST fire; on a 2xx the dedupe key (when one was
 * supplied) is recorded in the ledger and persisted.
 *
 * The payload is BUILT FROM A CLOSED ALLOW-LIST: exactly `{package, version, os, arch, node}`. There
 * is no free-form property path, so a leak is structurally impossible. `distinct_id` prefers the
 * shared `~/.honeycomb/install-id` written by the honeycomb installer (correlates the funnel across
 * products); when absent, a UUID is generated once and persisted in hive's own state dir
 * (`~/.honeycomb/hive/`, mode 0o700).
 *
 * Fail-soft everywhere: the POST is wrapped in a 2s AbortController timeout and a try/catch that
 * swallows EVERYTHING (timeout, network error, 4xx, 5xx, ledger IO). `emitTelemetry` resolves to a
 * structured {@link EmitOutcome} for tests; it NEVER rejects and NEVER changes a CLI verb's exit code.
 *
 * This module carries NO secret: the PostHog project key (`phc_...`) is a PUBLIC write-only ingest
 * key, baked at build time via esbuild `define` (never a runtime env read, never logged).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

import { HONEYCOMB_HOME_DIR, HIVE_VERSION } from "../shared/constants.js";

// ----------------------------------------------------------------------------
// Build-injected destination (esbuild `define`; empty key means hard-disabled).
// ----------------------------------------------------------------------------

/**
 * The PostHog project write-only ingest key (`phc_...`), build-injected via esbuild `define`. The
 * `typeof` guard means a tsc-only dev/test build (no define pass) falls through to `""`, which Gate 1
 * treats as HARD-DISABLED: an unkeyed build emits nothing, ever.
 */
export const POSTHOG_KEY: string = typeof __HONEYCOMB_POSTHOG_KEY__ === "string" ? __HONEYCOMB_POSTHOG_KEY__ : "";

/**
 * The PostHog ingest host, build-injected via esbuild `define`. Defaults to the US cloud when the
 * define is absent or empty. {@link POSTHOG_CAPTURE_PATH} is appended to this host and that is the
 * ONLY URL this module ever posts to.
 */
export const POSTHOG_HOST: string =
  typeof __HONEYCOMB_POSTHOG_HOST__ === "string" && __HONEYCOMB_POSTHOG_HOST__.length > 0
    ? __HONEYCOMB_POSTHOG_HOST__
    : "https://us.i.posthog.com";

/** The pinned PostHog capture path. The full ingest URL is `${host}${POSTHOG_CAPTURE_PATH}`. */
export const POSTHOG_CAPTURE_PATH = "/i/v0/e/" as const;

/** Build the full capture URL (`${host}${path}`), tolerating a trailing slash on the host. */
export function captureUrl(host: string = POSTHOG_HOST): string {
  return `${host.replace(/\/+$/, "")}${POSTHOG_CAPTURE_PATH}`;
}

// ----------------------------------------------------------------------------
// Opt-out env gates.
// ----------------------------------------------------------------------------

/** The Honeycomb-wide opt-out env var. `HONEYCOMB_TELEMETRY=0` silences ALL telemetry. */
export const ENV_TELEMETRY = "HONEYCOMB_TELEMETRY" as const;
/** The cross-tool opt-out standard. Any value other than empty or "0" silences ALL telemetry. */
export const ENV_DO_NOT_TRACK = "DO_NOT_TRACK" as const;

/**
 * True when the user has opted out via either env var. Mirrors honeycomb's and doctor's
 * `isOptedOut` so all three chokepoints agree on the same env contract.
 */
export function isOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[ENV_TELEMETRY] === "0") return true;
  const dnt = env[ENV_DO_NOT_TRACK];
  return dnt !== undefined && dnt !== "" && dnt !== "0";
}

// ----------------------------------------------------------------------------
// State locations: shared install-id (funnel correlation) + hive's own dir.
// ----------------------------------------------------------------------------

/**
 * hive's own state dir. hive already keeps per-product state under
 * `~/.honeycomb/hive/` (the staged Windows service unit lives there), so the telemetry install-id
 * fallback and the dedupe ledger live beside it. Created lazily with mode 0o700.
 */
export const HIVE_STATE_DIR = join(HONEYCOMB_HOME_DIR, "hive");

/**
 * The shared install-id written by the honeycomb installer. When present, its contents are used as
 * `distinct_id` so hive's lifecycle events correlate with the installer funnel.
 */
export const SHARED_INSTALL_ID_PATH = join(HONEYCOMB_HOME_DIR, "install-id");

/** Filename of hive's own generated install-id inside {@link HIVE_STATE_DIR}. */
export const INSTALL_ID_FILENAME = "install-id" as const;

/** Filename of the dedupe ledger inside {@link HIVE_STATE_DIR}. */
export const LEDGER_FILENAME = "telemetry.json" as const;

// ----------------------------------------------------------------------------
// The closed property allow-list.
// ----------------------------------------------------------------------------

/**
 * The CLOSED allow-list of property keys that may leave the machine. The payload is BUILT from
 * exactly these five keys by {@link buildAllowedProperties}; there is no caller-supplied property
 * path at all, so nothing else can egress.
 */
export const ALLOWED_PROPERTY_KEYS = ["package", "version", "os", "arch", "node"] as const;

/** One allow-listed property key. */
export type AllowedPropertyKey = (typeof ALLOWED_PROPERTY_KEYS)[number];

/** The allow-listed property bag: the EXACT shape that may leave the machine. */
export type AllowedProperties = Record<AllowedPropertyKey, string>;

/**
 * Assemble the allow-listed payload: the package name, the build version, and coarse platform facts
 * (OS family, CPU arch, node version). Never a hostname, a path, or any machine-identifying string.
 */
export function buildAllowedProperties(version: string): AllowedProperties {
  return {
    package: "hive",
    version,
    os: platform(),
    arch: arch(),
    node: process.version
  };
}

// ----------------------------------------------------------------------------
// The lifecycle event names.
// ----------------------------------------------------------------------------

/** The four hive lifecycle events. This union is the whole event vocabulary of this module. */
export type HiveTelemetryEvent =
  | "hive_installed"
  | "hive_uninstalled"
  | "hive_first_run"
  | "hive_updated";

// ----------------------------------------------------------------------------
// The dedupe ledger (a small JSON file in the state dir).
// ----------------------------------------------------------------------------

/**
 * The dedupe ledger persisted at `${stateDir}/telemetry.json`. `reported` maps a dedupe key (an event
 * name, or `event@version` for `hive_updated`) to the ISO timestamp it was sent. `lastSeenVersion`
 * is the version observed on the most recent lifecycle-recorded `start`, used to detect upgrades.
 */
export interface TelemetryLedger {
  readonly reported: Record<string, string>;
  readonly lastSeenVersion?: string;
}

/** An empty ledger (the fail-soft default when the file is absent or unreadable). */
function emptyLedger(): TelemetryLedger {
  return { reported: {} };
}

/** Load the ledger from `${stateDir}/telemetry.json`. Any IO/parse problem yields an empty ledger. */
export function loadLedger(stateDir: string): TelemetryLedger {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, LEDGER_FILENAME), "utf8"));
    if (typeof raw !== "object" || raw === null) return emptyLedger();
    const record = raw as Record<string, unknown>;
    const reported: Record<string, string> = {};
    if (typeof record["reported"] === "object" && record["reported"] !== null) {
      for (const [key, value] of Object.entries(record["reported"] as Record<string, unknown>)) {
        if (typeof value === "string") reported[key] = value;
      }
    }
    const lastSeenVersion = typeof record["lastSeenVersion"] === "string" ? record["lastSeenVersion"] : undefined;
    return lastSeenVersion === undefined ? { reported } : { reported, lastSeenVersion };
  } catch {
    return emptyLedger();
  }
}

/**
 * Persist the ledger, creating the state dir (mode 0o700) when needed. Throws on IO failure; callers
 * inside the chokepoint wrap it in the fail-soft try/catch.
 */
export function saveLedger(stateDir: string, ledger: TelemetryLedger): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, LEDGER_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// ----------------------------------------------------------------------------
// distinct_id resolution.
// ----------------------------------------------------------------------------

/**
 * Resolve the anonymized `distinct_id`, in preference order:
 *   1. The shared `~/.honeycomb/install-id` (honeycomb installer funnel correlation), when present.
 *   2. hive's own previously generated id at `${stateDir}/install-id`.
 *   3. A fresh UUID, persisted best-effort at `${stateDir}/install-id` (dir mode 0o700).
 * Never an email, account id, hostname, or path. Never throws: a persist failure still returns the
 * generated id (that emit just will not correlate with later ones).
 */
export function resolveDistinctId(deps: EmitDeps = {}): string {
  const sharedPath = deps.sharedInstallIdPath ?? SHARED_INSTALL_ID_PATH;
  try {
    const shared = readFileSync(sharedPath, "utf8").trim();
    if (shared.length > 0) return shared;
  } catch {
    // No shared install-id: fall through to hive's own id.
  }

  const stateDir = deps.stateDir ?? HIVE_STATE_DIR;
  const ownPath = join(stateDir, INSTALL_ID_FILENAME);
  try {
    const own = readFileSync(ownPath, "utf8").trim();
    if (own.length > 0) return own;
  } catch {
    // No persisted id yet: generate one below.
  }

  const generated = randomUUID();
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(ownPath, `${generated}\n`, "utf8");
  } catch {
    // Best-effort persistence: the generated id is still usable for this emit.
  }
  return generated;
}

// ----------------------------------------------------------------------------
// Injectable seams.
// ----------------------------------------------------------------------------

/** The minimal fetch response shape the chokepoint reads. */
export interface TelemetryFetchResponse {
  readonly ok: boolean;
  readonly status: number;
}

/** The minimal request init the chokepoint passes (POST + JSON body + abort signal). */
export interface TelemetryFetchRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/** The injectable fetch seam. Tests pass a recorder so no real network is ever hit. */
export type TelemetryFetch = (url: string, init: TelemetryFetchRequestInit) => Promise<TelemetryFetchResponse>;

/** The injectable deps the chokepoint runs against. All default to the production seams. */
export interface EmitDeps {
  /** The network seam (defaults to the global `fetch`). */
  readonly fetch?: TelemetryFetch;
  /** The env the opt-out gate reads (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override the build-injected key (tests force the keyed/unkeyed branch without a rebuild). */
  readonly posthogKey?: string;
  /** Override the capture host (tests assert the posted URL without a rebuild). */
  readonly posthogHost?: string;
  /** Override the version stamped into the payload (defaults to {@link HIVE_VERSION}). */
  readonly version?: string;
  /** Override hive's state dir (tests point this at a temp dir). */
  readonly stateDir?: string;
  /** Override the shared install-id path (tests point this at a temp file). */
  readonly sharedInstallIdPath?: string;
  /** The bounded POST timeout in ms (defaults to {@link DEFAULT_EMIT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** The clock stamping ledger entries (defaults to `new Date().toISOString()`). */
  readonly clock?: () => string;
}

/** The default bounded POST timeout: a telemetry POST never hangs a verb longer than this. */
export const DEFAULT_EMIT_TIMEOUT_MS = 2_000 as const;

// ----------------------------------------------------------------------------
// Outcome types (for tests and callers; never thrown).
// ----------------------------------------------------------------------------

/** Why an emit did NOT send. NEVER thrown: a gate or failure resolves to one of these. */
export type EmitSkipReason =
  | "disabled" // empty build key (unkeyed dev build)
  | "opted_out" // HONEYCOMB_TELEMETRY=0 or DO_NOT_TRACK truthy
  | "already_reported" // dedupe ledger hit
  | "send_failed"; // POST timed out / errored / non-2xx (swallowed)

/** The outcome of an {@link emitTelemetry} call (resolved, never rejected). */
export interface EmitOutcome {
  /** True iff a 2xx came back. */
  readonly sent: boolean;
  /** When `sent` is false, why. Absent when `sent` is true. */
  readonly skipped?: EmitSkipReason;
  /** The allow-listed payload that was built (present whether or not it was sent). */
  readonly properties: AllowedProperties;
}

/** The per-emit options. */
export interface EmitOptions {
  /**
   * When supplied, the emit is deduped: a ledger hit skips the send, and a successful send records
   * this key. Plain event names dedupe once per machine; `hive_updated@<version>` dedupes per
   * version. Omit for events that may fire more than once (`hive_uninstalled`).
   */
  readonly dedupeKey?: string;
}

/** The PostHog capture body shape: exactly `{ api_key, event, properties, distinct_id }`. */
interface CaptureBody {
  readonly api_key: string;
  readonly event: HiveTelemetryEvent;
  readonly properties: AllowedProperties;
  readonly distinct_id: string;
}

// ----------------------------------------------------------------------------
// The chokepoint.
// ----------------------------------------------------------------------------

/**
 * THE SINGLE TELEMETRY CHOKEPOINT. Emit `event` with the allow-listed payload, applying, in order,
 * the disabled / opted-out / already-reported gates, then a single bounded fire-and-forget POST. On a
 * 2xx the dedupe key (when supplied) is recorded in the ledger. NEVER throws and NEVER changes a CLI
 * verb's exit code: it resolves an {@link EmitOutcome} the caller may inspect or ignore.
 */
export async function emitTelemetry(
  event: HiveTelemetryEvent,
  opts: EmitOptions = {},
  deps: EmitDeps = {}
): Promise<EmitOutcome> {
  const env = deps.env ?? process.env;
  const key = deps.posthogKey ?? POSTHOG_KEY;
  const version = deps.version ?? HIVE_VERSION;
  const properties = buildAllowedProperties(version);

  // Gate 1: empty build key means hard-disabled (unkeyed dev build). No IO, no network.
  if (key.length === 0) return { sent: false, skipped: "disabled", properties };

  // Gate 2: opted out via either env var. No IO, no network.
  if (isOptedOut(env)) return { sent: false, skipped: "opted_out", properties };

  try {
    const stateDir = deps.stateDir ?? HIVE_STATE_DIR;
    const ledger = loadLedger(stateDir);

    // Gate 3: dedupe. A keyed emit sends at most once per ledger key.
    if (opts.dedupeKey !== undefined && ledger.reported[opts.dedupeKey] !== undefined) {
      return { sent: false, skipped: "already_reported", properties };
    }

    const distinctId = resolveDistinctId(deps);
    const ok = await postCapture(event, properties, distinctId, key, deps);
    if (!ok) return { sent: false, skipped: "send_failed", properties };

    if (opts.dedupeKey !== undefined) {
      const clock = deps.clock ?? ((): string => new Date().toISOString());
      try {
        // Reload before writing so a concurrent emit's mark is not clobbered.
        const fresh = loadLedger(stateDir);
        saveLedger(stateDir, {
          ...fresh,
          reported: { ...fresh.reported, [opts.dedupeKey]: clock() }
        });
      } catch {
        // A persist hiccup after a successful send is non-fatal; the send still counts.
      }
    }
    return { sent: true, properties };
  } catch {
    // Fail-soft: ANY unexpected error (ledger IO, a thrown fetch) is swallowed.
    return { sent: false, skipped: "send_failed", properties };
  }
}

/**
 * Issue the ONE bounded-timeout POST to the PostHog capture endpoint and return whether it was a 2xx.
 * Wrapped in an AbortController timeout plus a try/catch that swallows everything (timeout / network
 * / non-2xx). This is the ONLY function in this package that touches the telemetry network path; the
 * body is exactly `{ api_key, event, properties, distinct_id }`.
 */
async function postCapture(
  event: HiveTelemetryEvent,
  properties: AllowedProperties,
  distinctId: string,
  key: string,
  deps: EmitDeps
): Promise<boolean> {
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as TelemetryFetch);
  const host = deps.posthogHost ?? POSTHOG_HOST;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
  const body: CaptureBody = { api_key: key, event, properties, distinct_id: distinctId };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const resp = await doFetch(captureUrl(host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return resp.ok;
  } catch {
    // A dropped lifecycle event is acceptable; a hung CLI verb is not.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// The four lifecycle emit helpers (the only call sites, wired in src/cli.ts).
// ----------------------------------------------------------------------------

/** Emit `hive_installed` after a successful `install-service`. Deduped once per machine. */
export async function emitInstalled(deps: EmitDeps = {}): Promise<EmitOutcome> {
  return emitTelemetry("hive_installed", { dedupeKey: "hive_installed" }, deps);
}

/**
 * Emit `hive_uninstalled` on `uninstall-service`. Fired BEFORE teardown, fire-and-forget, and
 * deliberately NOT deduped: an install/uninstall/reinstall cycle legitimately fires it again.
 */
export async function emitUninstalled(deps: EmitDeps = {}): Promise<EmitOutcome> {
  return emitTelemetry("hive_uninstalled", {}, deps);
}

/** The outcome of the `start` lifecycle recording: the first-run emit plus the optional update emit. */
export interface StartLifecycleOutcome {
  readonly firstRun: EmitOutcome;
  /** Null when no version change was detected (or when the gates blocked everything). */
  readonly updated: EmitOutcome | null;
}

/**
 * Record the `start` lifecycle: emit `hive_first_run` once per machine, and emit
 * `hive_updated` when the persisted last-seen version differs from the current version (deduped
 * per version via `hive_updated@<version>`), then advance the persisted version. Capturing the
 * upgrade on `start` means an npm reinstall is detected without any updater. Fail-soft: never throws
 * and never blocks the daemon (the caller invokes it after the listen line).
 */
export async function recordStartLifecycle(deps: EmitDeps = {}): Promise<StartLifecycleOutcome> {
  const version = deps.version ?? HIVE_VERSION;
  const firstRun = await emitTelemetry("hive_first_run", { dedupeKey: "hive_first_run" }, deps);

  // When telemetry is disabled or opted out, do no bookkeeping at all: no dirs, no ledger.
  if (firstRun.skipped === "disabled" || firstRun.skipped === "opted_out") {
    return { firstRun, updated: null };
  }

  try {
    const stateDir = deps.stateDir ?? HIVE_STATE_DIR;
    const lastSeen = loadLedger(stateDir).lastSeenVersion;

    let updated: EmitOutcome | null = null;
    if (lastSeen !== undefined && lastSeen !== version) {
      updated = await emitTelemetry("hive_updated", { dedupeKey: `hive_updated@${version}` }, deps);
    }

    // Advance the persisted version on the very first recorded start, or once the update event for
    // the current version has been sent (or was already sent). A failed send leaves both the ledger
    // and lastSeenVersion untouched so the next start retries.
    const advance =
      lastSeen === undefined || (updated !== null && (updated.sent || updated.skipped === "already_reported"));
    if (advance) {
      const fresh = loadLedger(stateDir);
      saveLedger(stateDir, { ...fresh, lastSeenVersion: version });
    }
    return { firstRun, updated };
  } catch {
    // Fail-soft: ledger IO problems never surface to the daemon start path.
    return { firstRun, updated: null };
  }
}
