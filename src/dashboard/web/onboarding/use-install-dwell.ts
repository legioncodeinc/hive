/**
 * The install card's MINIMUM DWELL hook, PRD-009b ob-AC-11. Each product card must display for a
 * minimum of ~30 seconds even when the install finishes sooner; a longer install simply holds the
 * card until its own terminal state. The dwell timer NEVER masks a failure, this hook only ever
 * gates the advance-on-SUCCESS path; a failed card renders its error immediately regardless of how
 * much dwell time has elapsed (the caller never calls this hook's `ready` with a failure in mind).
 */

import React from "react";

/** ob-AC-11's "~30 seconds" as a duration. Overridable so tests never wait 30 real seconds. */
export const DEFAULT_MIN_DWELL_MS = 30_000;

export interface UseInstallDwellOptions {
	/** Called exactly once, after `ready` has been true for the remaining minimum-dwell duration. */
	readonly onDwellSatisfied: () => void;
	/** Overrides {@link DEFAULT_MIN_DWELL_MS} (a test injects a short window). */
	readonly minDwellMs?: number;
}

/**
 * `ready` flips true once the install reaches its `completed` terminal state. The card's mount
 * time is the dwell clock's start (installs begin the instant a card mounts), so a completion that
 * lands at second 6 still holds the card until second 30; a completion that lands at second 40 has
 * already satisfied the dwell and advances immediately.
 */
export function useInstallDwell(ready: boolean, options: UseInstallDwellOptions): void {
	const { minDwellMs = DEFAULT_MIN_DWELL_MS } = options;
	const startedAtRef = React.useRef<number>(Date.now());
	const firedRef = React.useRef(false);

	// Read through a ref so a caller passing a fresh `onDwellSatisfied` closure every render never
	// re-triggers the scheduling effect below (only `ready`/`minDwellMs` should do that).
	const onDwellSatisfiedRef = React.useRef(options.onDwellSatisfied);
	onDwellSatisfiedRef.current = options.onDwellSatisfied;

	React.useEffect(() => {
		if (!ready || firedRef.current) return;
		const elapsed = Date.now() - startedAtRef.current;
		const remaining = Math.max(0, minDwellMs - elapsed);
		const id = setTimeout(() => {
			firedRef.current = true;
			onDwellSatisfiedRef.current();
		}, remaining);
		return () => clearTimeout(id);
	}, [ready, minDwellMs]);
}
