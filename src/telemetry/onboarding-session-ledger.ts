/**
 * PRD-009c tm-AC-2: per-onboarding-session dedupe ledger.
 *
 * Once-per-session funnel milestones (`onboarding_started`, `health_check_passed`,
 * `login_completed`, `dashboard_reached`) are recorded here, keyed by a SHA-256 digest of the
 * one-time onboarding token. The token itself is never written to disk or emitted; only the digest
 * scopes dedupe within a session.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HIVE_STATE_DIR } from "./emit.js";

/** Filename of the session-scoped funnel dedupe ledger under {@link HIVE_STATE_DIR}. */
export const ONBOARDING_LEDGER_FILENAME = "onboarding-telemetry.json" as const;

/** Events that emit at most once per onboarding session (tm-AC-2). */
export const SESSION_ONCE_EVENTS = [
  "onboarding_started",
  "health_check_passed",
  "login_completed",
  "dashboard_reached"
] as const;

export type SessionOnceEvent = (typeof SESSION_ONCE_EVENTS)[number];

export interface OnboardingSessionLedger {
  readonly sessions: Record<string, { readonly reported: Record<string, string> }>;
}

function emptyLedger(): OnboardingSessionLedger {
  return { sessions: {} };
}

/** Derive a session key from the raw token without persisting or logging the token (tm-AC-5). */
export function sessionKeyFromToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Load the onboarding session ledger. Any IO or parse problem yields an empty ledger (fail-soft). */
export function loadOnboardingLedger(stateDir: string): OnboardingSessionLedger {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, ONBOARDING_LEDGER_FILENAME), "utf8"));
    if (typeof raw !== "object" || raw === null) return emptyLedger();
    const record = raw as Record<string, unknown>;
    const sessions: OnboardingSessionLedger["sessions"] = {};
    if (typeof record["sessions"] === "object" && record["sessions"] !== null) {
      for (const [sessionKey, bucket] of Object.entries(record["sessions"] as Record<string, unknown>)) {
        if (typeof bucket !== "object" || bucket === null) continue;
        const reported: Record<string, string> = {};
        const reportedRaw = (bucket as Record<string, unknown>)["reported"];
        if (typeof reportedRaw === "object" && reportedRaw !== null) {
          for (const [eventKey, ts] of Object.entries(reportedRaw as Record<string, unknown>)) {
            if (typeof ts === "string") reported[eventKey] = ts;
          }
        }
        sessions[sessionKey] = { reported };
      }
    }
    return { sessions };
  } catch {
    return emptyLedger();
  }
}

/** True when `event` was already reported for this session digest. */
export function isSessionEventReported(
  ledger: OnboardingSessionLedger,
  sessionKey: string,
  event: SessionOnceEvent
): boolean {
  return ledger.sessions[sessionKey]?.reported[event] !== undefined;
}

/**
 * Record a session-scoped dedupe mark after a successful send. Reloads before write so concurrent
 * marks are not clobbered. Throws on IO failure; callers wrap in fail-soft try/catch.
 */
export function markSessionEventReported(
  stateDir: string,
  sessionKey: string,
  event: SessionOnceEvent,
  clock: () => string
): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fresh = loadOnboardingLedger(stateDir);
  const prior = fresh.sessions[sessionKey]?.reported ?? {};
  const sessions = {
    ...fresh.sessions,
    [sessionKey]: { reported: { ...prior, [event]: clock() } }
  };
  writeFileSync(join(stateDir, ONBOARDING_LEDGER_FILENAME), `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
}

/** Default state dir when tests do not inject one. */
export const DEFAULT_ONBOARDING_LEDGER_DIR = HIVE_STATE_DIR;
