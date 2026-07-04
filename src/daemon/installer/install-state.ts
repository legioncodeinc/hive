/**
 * PRD-009a: the in-memory install state machine, SSE broadcast, and child-process orchestration
 * (is-AC-11 through is-AC-17).
 *
 * State is daemon-session scoped, not persisted (the parent PRD adds no store). Each product moves
 * through idle -> in_progress -> installed | failed. Progress is broadcast to any number of SSE
 * subscribers as staged events drawn from a closed set, NEVER a synthesized percentage (is-AC-12).
 * Stages are derived from real signals: `resolving` (target pinned), `downloading` (npm spawned),
 * `linking` (npm exited 0), `registering_service` (the product's own verb spawned), then
 * `completed` / `failed` from the verb's exit code. An install runs to its terminal state even if
 * every subscriber disconnects (is-AC-14): the work is owned by daemon-held state, not a browser tab.
 */

import type { InstallableProduct, InstallError, InstallStage, ProgressEvent } from "../../shared/onboarding-types.js";
import type { InstallerConfig } from "./config.js";
import { globalNodeModulesDir, locateNpmCliJs, resolvePackageBinJs } from "./bin-resolver.js";
import { productProfile } from "./products.js";

/** A resolved, shape-validated npm install target (from `manifest.ts`, never from the request). */
export interface InstallTarget {
  readonly packageName: string;
  readonly version: string;
  readonly target: string;
}

/** The lifecycle status of one product's install. */
export type InstallStatus = "idle" | "in_progress" | "installed" | "failed";

/** An SSE consumer of one product's progress stream. */
export interface ProgressSubscriber {
  send(event: ProgressEvent): void;
  close(): void;
}

/** The result of a `begin` call: a fresh install started, or attachment to an in-flight one (is-AC-16). */
export type BeginResult = "started" | "attached";

/** Optional funnel hooks; when absent, no telemetry is emitted. */
export interface InstallStateFunnelHooks {
  readonly onInstallStarted?: (product: InstallableProduct) => void;
  readonly onInstallCompleted?: (product: InstallableProduct) => void;
  readonly onInstallFailed?: (product: InstallableProduct, stage: InstallStage) => void;
}

/** A read-only snapshot of one product's install state, consumed by detection (is-AC-2). */
export interface ProductStateSnapshot {
  readonly status: InstallStatus;
  readonly currentStage: InstallStage | null;
  readonly error?: InstallError;
}

interface ProductRuntimeState {
  status: InstallStatus;
  currentStage: InstallStage | null;
  error?: InstallError;
  readonly subscribers: Set<ProgressSubscriber>;
  inFlight: Promise<void> | null;
}

/** The installer's session state: begin/attach installs, subscribe to progress, record funnel events. */
export interface InstallStateStore {
  detectState(product: InstallableProduct): ProductStateSnapshot;
  begin(product: InstallableProduct, target: InstallTarget): BeginResult;
  subscribe(product: InstallableProduct, subscriber: ProgressSubscriber): () => void;
  /** The in-flight install promise for a product (resolved when none), for test synchronization. */
  settled(product: InstallableProduct): Promise<void>;
}

/**
 * Network hardening flags for the npm install spawn. A flaky connection mid-download is the most
 * common install failure (read ETIMEDOUT); npm's default retry posture is stingy, so raise it and
 * let transient drops heal inside ONE attempt instead of surfacing as a failed card.
 */
export const NPM_INSTALL_NETWORK_FLAGS = [
  "--fetch-retries=5",
  "--fetch-retry-mintimeout=2000",
  "--fetch-retry-maxtimeout=30000",
  "--fetch-timeout=300000"
] as const;

/** Bound a spawn's error label + exit code + stderr tail into a single truthful summary (is-AC-17). */
function summarizeFailure(label: string, code: number | null, stderrTail: string): string {
  const trimmed = stderrTail.trim();
  const suffix = trimmed.length > 0 ? `: ${trimmed}` : "";
  return `${label} exited with code ${code ?? "null"}${suffix}`;
}

export function createInstallStateStore(
  config: InstallerConfig,
  hooks: InstallStateFunnelHooks = {}
): InstallStateStore {
  const states = new Map<InstallableProduct, ProductRuntimeState>();

  const stateFor = (product: InstallableProduct): ProductRuntimeState => {
    let state = states.get(product);
    if (state === undefined) {
      state = { status: "idle", currentStage: null, error: undefined, subscribers: new Set(), inFlight: null };
      states.set(product, state);
    }
    return state;
  };

  const broadcast = (state: ProductRuntimeState, event: ProgressEvent): void => {
    for (const subscriber of state.subscribers) {
      subscriber.send(event);
    }
  };

  const closeSubscribers = (state: ProductRuntimeState): void => {
    for (const subscriber of state.subscribers) {
      subscriber.close();
    }
    state.subscribers.clear();
  };

  const setStage = (state: ProductRuntimeState, stage: InstallStage, detail?: string): void => {
    state.currentStage = stage;
    broadcast(state, detail === undefined ? { stage } : { stage, detail });
  };

  const complete = (state: ProductRuntimeState, product: InstallableProduct): void => {
    state.status = "installed";
    state.error = undefined;
    setStage(state, "completed");
    hooks.onInstallCompleted?.(product);
    closeSubscribers(state);
  };

  const fail = (state: ProductRuntimeState, stage: InstallStage, summary: string, product: InstallableProduct): void => {
    state.status = "failed";
    state.error = { stage, summary };
    state.currentStage = "failed";
    hooks.onInstallFailed?.(product, stage);
    broadcast(state, { stage: "failed", detail: summary });
    closeSubscribers(state);
  };

  const performInstall = async (
    product: InstallableProduct,
    target: InstallTarget,
    state: ProductRuntimeState
  ): Promise<void> => {
    // Yield once so the synchronously-set `resolving` stage is observable in order before the
    // `downloading` transition (the install is already owned by daemon state at this point).
    await Promise.resolve();
    try {
      const npmCli = locateNpmCliJs(config);
      if (npmCli === null) {
        fail(state, "downloading", "npm executable could not be located", product);
        return;
      }

      setStage(state, "downloading");
      const npm = await config.spawn(config.execPath, [
        npmCli,
        "install",
        "-g",
        ...NPM_INSTALL_NETWORK_FLAGS,
        target.target
      ]);
      if (npm.code !== 0) {
        fail(state, "downloading", summarizeFailure("npm install", npm.code, npm.stderrTail), product);
        return;
      }

      setStage(state, "linking");

      const profile = productProfile(product);
      const prefix = await config.resolveNpmPrefix();
      const verbBin =
        prefix === null
          ? null
          : resolvePackageBinJs(config, globalNodeModulesDir(prefix, config.platform), target.packageName, profile.binName);
      if (verbBin === null) {
        fail(
          state,
          "registering_service",
          `could not resolve the ${profile.binName} bin to run its registration verb`,
          product
        );
        return;
      }

      setStage(state, "registering_service");
      const registration = await config.spawn(config.execPath, [verbBin, ...profile.registrationVerb]);
      if (registration.code !== 0) {
        const label = `${profile.binName} ${profile.registrationVerb.join(" ")}`;
        fail(state, "registering_service", summarizeFailure(label, registration.code, registration.stderrTail), product);
        return;
      }

      complete(state, product);
    } catch (error) {
      const stage: InstallStage = state.currentStage === "registering_service" ? "registering_service" : "downloading";
      fail(state, stage, error instanceof Error ? error.message : String(error), product);
    }
  };

  return {
    detectState(product): ProductStateSnapshot {
      const state = stateFor(product);
      return { status: state.status, currentStage: state.currentStage, error: state.error };
    },

    begin(product, target): BeginResult {
      const state = stateFor(product);
      // is-AC-16: a second concurrent request attaches to the in-flight install; only one child runs.
      if (state.status === "in_progress") return "attached";

      // is-AC-17: a prior failure is retryable; reset and run again.
      state.status = "in_progress";
      state.error = undefined;
      setStage(state, "resolving");
      hooks.onInstallStarted?.(product);
      state.inFlight = performInstall(product, target, state);
      return "started";
    },

    subscribe(product, subscriber): () => void {
      const state = stateFor(product);
      state.subscribers.add(subscriber);

      // is-AC-14: immediately replay the CURRENT stage so a re-attached client catches up.
      if (state.currentStage !== null) {
        const detail = state.currentStage === "failed" ? state.error?.summary : undefined;
        subscriber.send(detail === undefined ? { stage: state.currentStage } : { stage: state.currentStage, detail });
      }
      // If the install has already reached a terminal state, end this late subscriber's stream.
      if (state.status === "installed" || state.status === "failed") {
        state.subscribers.delete(subscriber);
        subscriber.close();
        return () => undefined;
      }

      return () => {
        state.subscribers.delete(subscriber);
      };
    },

    settled(product): Promise<void> {
      return stateFor(product).inFlight ?? Promise.resolve();
    }
  };
}
