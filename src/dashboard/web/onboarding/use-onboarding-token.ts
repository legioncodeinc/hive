/**
 * The one-time onboarding TOKEN hook, PRD-009b implementation note. The bootstrap mints the token
 * and hands it to the browser via `/onboarding?t=...`; this hook reads it ONCE on mount, keeps it
 * in React state (memory only) for the page's lifetime, and immediately strips it from the visible
 * URL via `history.replaceState` so casual screen-sharing never exposes it. The read+strip is a side
 * effect, so it runs inside `useEffect` (not a `useState` lazy initializer), render must stay pure.
 */

import React from "react";

const TOKEN_QUERY_PARAM = "t" as const;

/**
 * Read `?t=` once, strip it from the visible URL, and return the token. Tri-state so the caller can
 * distinguish "still resolving" from "resolved, absent": `null` until the mount effect has run,
 * `""` when the URL carried no token (the caller shows recovery guidance rather than spinning
 * forever), and the token string otherwise.
 */
export function useOnboardingToken(): string | null {
	const [token, setToken] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (typeof window === "undefined") return;
		const params = new URLSearchParams(window.location.search);
		const fromUrl = params.get(TOKEN_QUERY_PARAM);
		if (fromUrl === null || fromUrl === "") {
			setToken("");
			return;
		}

		setToken(fromUrl);

		// Move it out of the visible URL (PRD implementation note), the token stays in memory only.
		try {
			const url = new URL(window.location.href);
			url.searchParams.delete(TOKEN_QUERY_PARAM);
			window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
		} catch {
			// A `history` API failure (e.g. an unusual embedding context) must never block the flow ,
			// the token still landed in state; only the cosmetic URL scrub is skipped.
		}
	}, []);

	return token;
}
