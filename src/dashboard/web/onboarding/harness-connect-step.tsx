/**
 * The onboarding "Connect your coding assistant" step, PRD-006c (c-AC-2/3/5).
 *
 * On mount it triggers the honeycomb harness reconcile (`onboardingClient.connectHarness()`, which
 * shells `honeycomb harness connect --json` server-side) and renders the outcome:
 *   - `connected`                 -> "Claude Code connected" success + Continue (c-AC-2).
 *   - `cli-absent` / `agent-absent` -> "Install Claude Code, then Retry" + an install-docs link and
 *                                     a Retry that re-runs connect (c-AC-3).
 *   - `error`                     -> a generic "could not connect" + Retry.
 *
 * A ghost Skip affordance is ALWAYS present (c-AC-5, the product default): the step is per-step
 * skippable and never blocks onboarding completion. Both Continue and Skip advance via `onDone`, so
 * the step can never hang or dead-end, a down/absent honeycomb CLI still leaves a clear way forward.
 *
 * Presentation mirrors `login-step.tsx` (the same DS tokens + `Badge`/`Button` primitives); no new
 * asset, primitive, or funnel event is introduced.
 */

import React from "react";

import { Badge, Button } from "../primitives.js";
import type { HarnessConnectResult } from "./onboarding-client.js";
import type { OnboardingClient } from "./onboarding-client.js";

/** The Claude Code setup docs the install-retry state links to (c-AC-3). */
export const CLAUDE_CODE_INSTALL_DOCS = "https://docs.claude.com/en/docs/claude-code/setup" as const;

export interface HarnessConnectStepProps {
	/** The onboarding wire client (provides `connectHarness()`). */
	readonly onboardingClient: OnboardingClient;
	/** Advance out of this step (wired by the parent to the terminal navigation). Continue + Skip both call it. */
	readonly onDone: () => void;
}

/** The connect state machine: probing on mount, then the resolved result. */
type ConnectPhase = { readonly kind: "connecting" } | { readonly kind: "result"; readonly result: HarnessConnectResult };

/** True for the two states that mean "the agent/CLI is not present" (the install-then-retry copy, c-AC-3). */
function isInstallState(status: HarnessConnectResult["status"]): boolean {
	return status === "cli-absent" || status === "agent-absent";
}

/** The shared page shell (centered card), matching `login-step.tsx`'s layout. */
function StepShell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
	return (
		<div
			data-testid="onboarding-harness-connect-step"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 20,
				minHeight: "100vh",
				padding: 28,
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Connect your coding assistant
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Hive wires the honeycomb plugin into Claude Code so your memory follows you into every session.
				</p>
			</div>
			{children}
		</div>
	);
}

/** A ghost Skip control, always available so the step never blocks completion (c-AC-5). */
function SkipButton({ onSkip }: { readonly onSkip: () => void }): React.JSX.Element {
	return (
		<Button variant="ghost" size="sm" onClick={onSkip} data-testid="harness-connect-skip">
			Skip for now
		</Button>
	);
}

export function HarnessConnectStep({ onboardingClient, onDone }: HarnessConnectStepProps): React.JSX.Element {
	const [phase, setPhase] = React.useState<ConnectPhase>({ kind: "connecting" });

	// Guards the post-await state write: if the operator clicks Skip (which unmounts this step) while
	// a connect is in flight, the resolving `setPhase` would fire on an unmounted component.
	const mountedRef = React.useRef(true);

	// One shared "run the connect trigger" routine: the on-mount auto-run and the Retry button both
	// go through here, so an absent agent / failed attempt is always recoverable with one click.
	const runConnect = React.useCallback(async (): Promise<void> => {
		setPhase({ kind: "connecting" });
		const result = await onboardingClient.connectHarness();
		if (!mountedRef.current) return;
		setPhase({ kind: "result", result });
	}, [onboardingClient]);

	const startedRef = React.useRef(false);
	React.useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		void runConnect();
		return () => {
			mountedRef.current = false;
		};
	}, [runConnect]);

	if (phase.kind === "connecting") {
		return (
			<StepShell>
				<p data-testid="harness-connect-connecting" style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
					Connecting Claude Code…
				</p>
				<SkipButton onSkip={onDone} />
			</StepShell>
		);
	}

	const { status, detail } = phase.result;

	if (status === "connected") {
		return (
			<StepShell>
				<div
					data-testid="harness-connect-connected"
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 14,
						width: "100%",
						maxWidth: 480,
						padding: "22px 24px",
						background: "var(--bg-elevated)",
						border: "1px solid var(--border-default)",
						borderRadius: "var(--radius-lg)",
					}}
				>
					<Badge tone="verified" mono dot>
						Claude Code connected
					</Badge>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
						The honeycomb plugin is enabled. Your captured work and recall are live in Claude Code.
					</p>
					<Button variant="primary" size="md" onClick={onDone} data-testid="harness-connect-continue">
						Continue
					</Button>
				</div>
			</StepShell>
		);
	}

	if (isInstallState(status)) {
		return (
			<StepShell>
				<div
					data-testid="harness-connect-install"
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 12,
						width: "100%",
						maxWidth: 480,
						padding: "20px 22px",
						background: "var(--bg-elevated)",
						border: "1px solid var(--border-default)",
						borderRadius: "var(--radius-lg)",
					}}
				>
					<Badge tone="warning" mono dot>
						Claude Code not found
					</Badge>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
						We could not find Claude Code on this machine. Install it, then retry the connection.
					</p>
					<a
						href={CLAUDE_CODE_INSTALL_DOCS}
						target="_blank"
						rel="noreferrer"
						data-testid="harness-connect-install-link"
						style={{ fontSize: "var(--text-sm)", color: "var(--honey)", fontWeight: 600 }}
					>
						How to install Claude Code →
					</a>
					<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
						<Button variant="primary" size="md" onClick={() => void runConnect()} data-testid="harness-connect-retry">
							Retry
						</Button>
						<SkipButton onSkip={onDone} />
					</div>
				</div>
			</StepShell>
		);
	}

	// status === "error" — a probe/wire threw or timed out; offer a generic retry (c-AC-5).
	return (
		<StepShell>
			<div
				data-testid="harness-connect-error"
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 12,
					width: "100%",
					maxWidth: 480,
					padding: "20px 22px",
					background: "var(--bg-elevated)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-lg)",
				}}
			>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
					Could not connect Claude Code{detail !== undefined && detail !== "" ? ` (${detail})` : ""}.
				</p>
				<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
					<Button variant="primary" size="md" onClick={() => void runConnect()} data-testid="harness-connect-retry">
						Retry
					</Button>
					<SkipButton onSkip={onDone} />
				</div>
			</div>
		</StepShell>
	);
}
