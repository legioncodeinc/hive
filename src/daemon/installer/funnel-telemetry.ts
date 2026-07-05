/**
 * PRD-009c: daemon-side onboarding funnel emission.
 *
 * Every funnel byte leaves through {@link emitTelemetry} in `src/telemetry/emit.ts`. UI-originated
 * milestones arrive via the token-gated event route; install and auth milestones are observed from
 * daemon state transitions. Session-scoped dedupe lives in `onboarding-session-ledger.ts`.
 */

import { z } from "zod";

import type { InstallableProduct, InstallStage } from "../../shared/onboarding-types.js";
import {
  emitTelemetry,
  HIVE_STATE_DIR,
  type EmitDeps,
  type FunnelExtras,
  type FunnelFailureStage,
  type FunnelMode,
  type OnboardingFunnelEvent
} from "../../telemetry/emit.js";
import {
  isSessionEventReported,
  loadOnboardingLedger,
  markSessionEventReported,
  sessionKeyFromToken,
  type SessionOnceEvent
} from "../../telemetry/onboarding-session-ledger.js";
import type { InstallerConfig } from "./config.js";

/** UI-reported funnel events validated at the event route (tm-AC-1; PRD-011a ts-AC-13 tenancy set). */
export const UI_FUNNEL_EVENTS = [
  "onboarding_started",
  "mode_selected",
  "login_shown",
  "tenancy_shown",
  "tenancy_selected",
  "workspace_created",
  "dashboard_reached"
] as const;

export type UiFunnelEvent = (typeof UI_FUNNEL_EVENTS)[number];

const ModeSelectedBodySchema = z.object({
  event: z.literal("mode_selected"),
  properties: z.object({ mode: z.enum(["standard", "advanced"]) })
});

/**
 * PRD-011a ts-AC-13: `tenancy_selected` carries ONLY a bucketed org count and the single-org-confirm
 * flag (both closed enums; never an org/workspace id or name). Mirrors the UI emit in
 * `src/dashboard/web/onboarding/tenancy-step.tsx`.
 */
const TenancySelectedBodySchema = z.object({
  event: z.literal("tenancy_selected"),
  properties: z.object({
    orgCount: z.enum(["single", "few", "many"]),
    singleOrgConfirm: z.enum(["true", "false"])
  })
});

const SimpleUiEventBodySchema = z.object({
  event: z.enum(["onboarding_started", "login_shown", "tenancy_shown", "workspace_created", "dashboard_reached"]),
  properties: z.record(z.string(), z.string()).optional()
});

/** Closed zod schema for `POST /api/onboarding/event` bodies. */
export const OnboardingEventBodySchema = z.union([
  ModeSelectedBodySchema,
  TenancySelectedBodySchema,
  SimpleUiEventBodySchema
]);

export type ParsedOnboardingEvent = z.infer<typeof OnboardingEventBodySchema>;

const SESSION_ONCE_SET = new Set<SessionOnceEvent>([
  "onboarding_started",
  "health_check_passed",
  "login_completed",
  "dashboard_reached"
]);

const INSTALL_STAGES: readonly FunnelFailureStage[] = [
  "resolving",
  "downloading",
  "linking",
  "registering_service"
];

function failureStageFromInstallStage(stage: InstallStage): FunnelFailureStage | null {
  if (stage === "completed" || stage === "failed") return null;
  return (INSTALL_STAGES as readonly string[]).includes(stage) ? (stage as FunnelFailureStage) : null;
}

export interface FunnelTelemetryDeps {
  readonly config: InstallerConfig;
  readonly emitDeps?: EmitDeps;
  readonly stateDir?: string;
  readonly clock?: () => string;
}

/** The funnel emitter wired into installer routes and the install state machine. */
export interface FunnelTelemetry {
  /** Handle a validated UI event body from the event route. */
  recordUiEvent(body: ParsedOnboardingEvent): void;
  /** Emit when a new install begins (not attach, not short-circuit). */
  recordProductInstallStarted(product: InstallableProduct): void;
  /** Emit when an install reaches the completed stage. */
  recordProductInstallCompleted(product: InstallableProduct): void;
  /** Emit when an install fails at a closed stage. */
  recordProductInstallFailed(product: InstallableProduct, stage: InstallStage): void;
  /** Observe fleet readiness; emits `health_check_passed` once when ready becomes true. */
  observeHealthReady(ready: boolean): void;
  /** Observe auth; emits `login_completed` once when authenticated flips true (tm-AC-1). */
  observeAuthenticated(authenticated: boolean): void;
}

function readSessionKey(config: InstallerConfig): string | null {
  const raw = config.readTextFile(config.tokenPath);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return sessionKeyFromToken(trimmed);
}

function fireAndForget(run: () => Promise<void>): void {
  void run().catch(() => {
    // Fail-soft: telemetry never affects install behavior (tm-AC-3).
  });
}

export function createFunnelTelemetry(deps: FunnelTelemetryDeps): FunnelTelemetry {
  const stateDir = deps.stateDir ?? deps.emitDeps?.stateDir ?? HIVE_STATE_DIR;
  const emitDeps = deps.emitDeps ?? {};
  const clock = deps.clock ?? ((): string => new Date().toISOString());
  let sawAuthenticated = false;

  const emit = (event: OnboardingFunnelEvent, extras: FunnelExtras = {}, dedupeSession = false): void => {
    fireAndForget(async () => {
      const sessionKey = readSessionKey(deps.config);
      if (dedupeSession && sessionKey !== null) {
        if (!SESSION_ONCE_SET.has(event as SessionOnceEvent)) return;
        const ledger = loadOnboardingLedger(stateDir);
        if (isSessionEventReported(ledger, sessionKey, event as SessionOnceEvent)) return;
      }

      const outcome = await emitTelemetry(event, {}, emitDeps, extras);
      if (
        outcome.sent &&
        dedupeSession &&
        sessionKey !== null &&
        SESSION_ONCE_SET.has(event as SessionOnceEvent)
      ) {
        try {
          markSessionEventReported(stateDir, sessionKey, event as SessionOnceEvent, clock);
        } catch {
          // Persist hiccup after a successful send is non-fatal.
        }
      }
    });
  };

  return {
    recordUiEvent(body): void {
      switch (body.event) {
        case "mode_selected":
          emit("mode_selected", { mode: body.properties.mode as FunnelMode });
          break;
        case "onboarding_started":
          emit("onboarding_started", {}, true);
          break;
        case "login_shown":
          emit("login_shown");
          break;
        case "tenancy_shown":
          emit("tenancy_shown");
          break;
        case "tenancy_selected":
          emit("tenancy_selected", {
            org_count: body.properties.orgCount,
            single_org_confirm: body.properties.singleOrgConfirm
          });
          break;
        case "workspace_created":
          emit("workspace_created");
          break;
        case "dashboard_reached":
          emit("dashboard_reached", {}, true);
          break;
        default: {
          const _exhaustive: never = body;
          void _exhaustive;
        }
      }
    },

    recordProductInstallStarted(product): void {
      emit("product_install_started", { product });
    },

    recordProductInstallCompleted(product): void {
      emit("product_install_completed", { product });
    },

    recordProductInstallFailed(product, stage): void {
      const failureStage = failureStageFromInstallStage(stage);
      if (failureStage === null) return;
      emit("product_install_failed", { product, failure_stage: failureStage });
    },

    observeHealthReady(ready): void {
      if (!ready) return;
      emit("health_check_passed", {}, true);
    },

    observeAuthenticated(authenticated): void {
      if (!authenticated || sawAuthenticated) return;
      sawAuthenticated = true;
      emit("login_completed", {}, true);
    }
  };
}
