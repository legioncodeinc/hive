/**
 * The bundle's BOOT SCREEN selector — PRD-003c (m-AC-6 / m-AC-7 / m-AC-8).
 *
 * By the time this bundle runs, thehive's SERVER gate (`the-hive/src/daemon/gate.ts`, PRD-003a)
 * has already evaluated health-then-auth and served the shell ONLY for a path it authorized:
 * `/buzzing` (fleet not healthy, or landed there directly — always exempt), `/login` (logged out,
 * or landed there directly — always exempt), or any other path (healthy + authenticated). This
 * pure function is the whole boot decision `main.tsx` needs: a plain lookup from `location.pathname`
 * to which top-level screen to mount. It never re-derives health or auth itself — doing so would
 * resurrect the retired `ReadinessSplash`→`SetupGate` nested client gate (ADR-0004, m-AC-6).
 */

export type BootScreen = "buzzing" | "login" | "shell";

/** The `/buzzing` route (PRD-002's readiness splash, now the gate-exempt readiness screen). */
export const BUZZING_PATH = "/buzzing" as const;

/** The `/login` route (PRD-003b's device-flow guided setup, now the gate-exempt login screen). */
export const LOGIN_PATH = "/login" as const;

/**
 * Resolve which top-level screen `main.tsx` should mount for the current path. `/buzzing` and
 * `/login` are the two gate-exempt screens (m-AC-7 / m-AC-8); every other path — including `/` and
 * every registry route (`/projects`, `/harnesses`, ...) — mounts the authenticated `<Shell>`,
 * whose own path router (`router.tsx`) then resolves the specific page via `registry.tsx`.
 */
export function resolveBootScreen(pathname: string): BootScreen {
	if (pathname === BUZZING_PATH) return "buzzing";
	if (pathname === LOGIN_PATH) return "login";
	return "shell";
}
