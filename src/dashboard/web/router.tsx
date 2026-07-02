/**
 * The dashboard CLIENT-SIDE ROUTER — PRD-003c (m-AC-1 / m-AC-2, retiring the hash router).
 *
 * hive's SERVER is now the routing authority (PRD-003a): it evaluates the health-then-auth
 * gate on every request and serves the identical SPA shell for every real, path-based route
 * (`hive/src/daemon/dashboard/host.ts`'s catch-all). This hook's job narrows to what a
 * server-routed SPA needs client-side: read the ALREADY-AUTHORIZED path the server served
 * (`location.pathname`), keep it in sync with History API navigation (back/forward, and this
 * hook's own `navigate`), and re-render. It does NOT decide what the operator is ALLOWED to see —
 * that decision was already made server-side before this bundle ever ran.
 *
 * This RETIRES `useHashRoute` / `routeFromHash` (m-AC-1): routing no longer reads `location.hash`,
 * and `navigate` calls `history.pushState` instead of assigning `location.hash`, so history entries
 * are real paths, not fragments (m-AC-2). Still NO `react-router`, NO new dependency — the History
 * API is a browser primitive, mirroring the hash hook's own no-new-dependency posture.
 */

import React from "react";

/**
 * Parse the current route string from `location.pathname`. Normalizes an empty path to the
 * default `/`. The returned value is the RAW route key (e.g. `/graph`); resolving it to a
 * registry entry (and the unknown→Dashboard fallback) is `matchRoute`'s job (`registry.tsx`), not
 * this parser's — this keeps the hook a pure reflection of the URL, mirroring `routeFromHash`'s
 * old contract one-for-one, just sourced from the path instead of the fragment.
 */
export function routeFromPath(pathname: string): string {
	const trimmed = pathname.trim();
	return trimmed === "" ? "/" : trimmed;
}

/**
 * The custom window event `navigate` broadcasts after `pushState`. `pushState` fires no browser
 * event of its own, and several components mount their OWN `usePathRoute()` instance (the Shell in
 * `app.tsx`, `HarnessesPage`), so without a broadcast only the instance whose `navigate` ran would
 * re-render and every other subscriber's `route` would go stale until a real `popstate`.
 */
export const ROUTE_CHANGE_EVENT = "hive:pathchange" as const;

/** The path-router contract the Shell consumes: the active route + a `navigate` helper. */
export interface PathRoute {
	/** The active route parsed from `location.pathname` (e.g. `/` or `/graph`). */
	readonly route: string;
	/** Push `r` onto the History API (the `popstate`/local-state sync then re-renders). The ONLY history mutator. */
	readonly navigate: (r: string) => void;
}

/**
 * Read the active route from `location.pathname` and re-render on `popstate` (m-AC-2: back/forward
 * resolves the same screens). Subscribes in a `useEffect` and unsubscribes on unmount. `navigate(r)`
 * pushes a new History entry via `history.pushState` — which does NOT itself fire `popstate` — so
 * `navigate` updates the local route state directly too; this keeps exactly one source of truth
 * (the URL) and one mutator (`navigate`), mirroring the retired hash hook's contract. Deep-linking
 * works for free: the initial state reads whatever path the page loaded with (the server already
 * validated it via the gate), so a refresh on `/graph` mounts the Graph route.
 */
export function usePathRoute(): PathRoute {
	const [route, setRoute] = React.useState<string>(() =>
		// SSR/test-safe initial read: `window` exists in jsdom + the browser; guard defensively.
		typeof window === "undefined" ? "/" : routeFromPath(window.location.pathname),
	);

	React.useEffect(() => {
		if (typeof window === "undefined") return;
		const sync = (): void => setRoute(routeFromPath(window.location.pathname));
		// Re-sync once on mount in case the path changed between the initial render and the effect.
		sync();
		window.addEventListener("popstate", sync);
		window.addEventListener(ROUTE_CHANGE_EVENT, sync);
		return () => {
			window.removeEventListener("popstate", sync);
			window.removeEventListener(ROUTE_CHANGE_EVENT, sync);
		};
	}, []);

	const navigate = React.useCallback((r: string): void => {
		if (typeof window === "undefined") return;
		const next = r.startsWith("/") ? r : `/${r}`;
		// `pushState` does not fire `popstate`, so broadcast the change instead: EVERY mounted
		// `usePathRoute()` instance (not just this one) re-syncs from `location.pathname`, keeping
		// the URL the single source of truth across all subscribers.
		if (window.location.pathname !== next) {
			window.history.pushState(null, "", next);
		}
		window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
	}, []);

	return { route, navigate };
}
