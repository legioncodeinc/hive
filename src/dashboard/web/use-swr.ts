/**
 * useSwr — a dependency-free stale-while-revalidate hook for dashboard read models (PRD-012b).
 *
 * Serves the cached value instantly on mount (no empty flash), deduplicates concurrent in-flight
 * requests for the same key, revalidates in the background on focus and on a configurable interval,
 * and exposes a mutation API that invalidates entries by key prefix. Inherits the background-tab
 * pause from {@link isTabHidden} (`page-frame.tsx`) — the same posture as {@link usePoll}.
 *
 * Copy-and-own per ADR-0001: no TanStack Query, no SWR npm package. The module-level cache is
 * in-memory, per-tab, lost on reload. The proxy cache from prd-012a makes the background revalidate
 * cheap; this hook makes the warm-navigation render instant.
 */

import React from "react";

import { isTabHidden } from "./page-frame.js";

// ── Module-level cache (in-memory, per-tab) ───────────────────────────────────

interface SwrCacheEntry {
	readonly value: unknown;
	readonly ts: number;
}

const cache = new Map<string, SwrCacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<() => void>>();

/**
 * Fire (or join) the in-flight fetch for `key`. Two hooks mounting the same key in the same tick
 * share one promise (dedupe); both resolve together, the cache is written once.
 */
function fetchSwr<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = inflight.get(key);
	if (existing !== undefined) return existing as Promise<T>;
	const p = fn().then(
		(value: T) => {
			cache.set(key, { value, ts: Date.now() });
			inflight.delete(key);
			return value;
		},
		(err: unknown) => {
			inflight.delete(key);
			throw err;
		},
	);
	inflight.set(key, p);
	return p;
}

function getSubs(key: string): Set<() => void> {
	let s = subscribers.get(key);
	if (s === undefined) {
		s = new Set();
		subscribers.set(key, s);
	}
	return s;
}

// ── Public mutation API ───────────────────────────────────────────────────────

/**
 * Drop every SWR cache entry whose key starts with any of `prefixes`, then schedule a revalidate
 * for each mounted hook whose key was dropped. Mirrors the server-side WRITE_INVALIDATIONS map
 * (prd-012a) so the client invalidates the same set the proxy does after a write.
 */
export function invalidateSwr(...prefixes: string[]): void {
	if (prefixes.length === 0) return;
	const triggers: (() => void)[] = [];
	for (const [k] of cache) {
		if (prefixes.some((p) => k.startsWith(p))) cache.delete(k);
	}
	for (const [k, subs] of subscribers) {
		if (prefixes.some((p) => k.startsWith(p))) {
			for (const t of subs) triggers.push(t);
		}
	}
	for (const t of triggers) t();
}

/** Drop every SWR cache entry and revalidate all mounted hooks. Used on org/workspace switch. */
export function clearSwrCache(): void {
	cache.clear();
	const triggers: (() => void)[] = [];
	for (const subs of subscribers.values()) {
		for (const t of subs) triggers.push(t);
	}
	for (const t of triggers) t();
}

// ── Key helper ────────────────────────────────────────────────────────────────

/**
 * Build a stable SWR key from an endpoint path and an optional project id. The project suffix is
 * REQUIRED for project-scoped reads (prevents cross-project collisions in the cache).
 */
export function swrKey(endpoint: string, projectId?: string): string {
	return projectId ? `${endpoint}:${projectId}` : endpoint;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SwrOptions<T> {
	/** Revalidate on an interval (ms). 0 = no interval revalidation (mount + focus only). */
	readonly refreshInterval?: number;
	/** Keep rendering the previous data while a revalidate is in flight (default true). */
	readonly keepPreviousData?: boolean;
	/** Revalidate when the tab is foregrounded (default true, matches usePoll). */
	readonly revalidateOnFocus?: boolean;
	/** Dedupe window (ms): a revalidate within this window is skipped (default 2000). */
	readonly dedupeMs?: number;
}

export interface SwrResult<T> {
	readonly data: T | undefined;
	readonly error: "loading" | "failed" | null;
	readonly loading: boolean;
	readonly isValidating: boolean;
	readonly mutate: (opts?: { readonly revalidate?: boolean }) => void;
}

// ── The hook ──────────────────────────────────────────────────────────────────

interface Snapshot<T> {
	readonly data: T | undefined;
	readonly error: "loading" | "failed" | null;
	readonly isValidating: boolean;
}

function readSnapshot<T>(key: string | undefined): Snapshot<T> {
	if (key === undefined) return { data: undefined, error: null, isValidating: false };
	const entry = cache.get(key);
	if (entry !== undefined) return { data: entry.value as T, error: null, isValidating: true };
	return { data: undefined, error: "loading", isValidating: true };
}

/**
 * Read a dashboard view-model with stale-while-revalidate semantics.
 *
 * @param key  Stable string key (or `undefined` to disable the hook). Convention: `swrKey(endpoint, projectId)`.
 * @param fn   The fetcher. Receives no args; closes over the wire client. Returns T or throws.
 */
export function useSwr<T>(key: string | undefined, fn: () => Promise<T>, options?: SwrOptions<T>): SwrResult<T> {
	const refreshInterval = options?.refreshInterval ?? 0;
	const keepPreviousData = options?.keepPreviousData ?? true;
	const revalidateOnFocus = options?.revalidateOnFocus ?? true;
	const dedupeMs = options?.dedupeMs ?? 2000;

	const fnRef = React.useRef(fn);
	fnRef.current = fn;
	const revalidateRef = React.useRef<(() => void) | undefined>(undefined);

	const [snapshot, setSnapshot] = React.useState<Snapshot<T>>(() => readSnapshot<T>(key));
	const [prevKey, setPrevKey] = React.useState(key);

	// Sync snapshot on key change (React-recommended pattern — avoids a stale-data flash).
	if (key !== prevKey) {
		setPrevKey(key);
		setSnapshot(readSnapshot<T>(key));
	}

	React.useEffect(() => {
		if (key === undefined) {
			revalidateRef.current = undefined;
			return;
		}

		let alive = true;

		const revalidate = async (force: boolean): Promise<void> => {
			if (!alive) return;
			if (!force) {
				const entry = cache.get(key);
				if (entry !== undefined && Date.now() - entry.ts < dedupeMs) return;
			}
			setSnapshot((prev) => ({
				data: keepPreviousData ? prev.data : undefined,
				error: prev.data === undefined ? "loading" : prev.error,
				isValidating: true,
			}));
			try {
				const value = await fetchSwr(key, () => fnRef.current());
				if (alive) setSnapshot({ data: value, error: null, isValidating: false });
			} catch {
				if (alive) {
					const entry = cache.get(key);
					setSnapshot({
						data: entry !== undefined ? (entry.value as T) : undefined,
						error: "failed",
						isValidating: false,
					});
				}
			}
		};

		// Initial mount: ALWAYS revalidate (bypass dedupe). Stale-while-revalidate means serve the
		// cached value AND refresh it — the dedupe window applies only to interval/focus/manual revalidations.
		void revalidate(true);

		// Subscribe for invalidation-triggered revalidations (force = true; the entry was dropped).
		const trigger = (): void => {
			if (alive) void revalidate(true);
		};
		revalidateRef.current = trigger;
		const subs = getSubs(key);
		subs.add(trigger);

		// Interval (skipped while the tab is backgrounded — matches usePoll).
		let intervalId: ReturnType<typeof setInterval> | undefined;
		if (refreshInterval > 0) {
			intervalId = setInterval(() => {
				if (alive && !isTabHidden()) void revalidate(false);
			}, refreshInterval);
		}

		// Re-foreground → immediate revalidate (matches usePoll's visibilitychange behavior).
		const onVisible = (): void => {
			if (alive && !isTabHidden() && revalidateOnFocus) void revalidate(false);
		};
		document.addEventListener("visibilitychange", onVisible);

		return () => {
			alive = false;
			subs.delete(trigger);
			revalidateRef.current = undefined;
			if (intervalId !== undefined) clearInterval(intervalId);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [key, refreshInterval, keepPreviousData, revalidateOnFocus, dedupeMs]);

	const mutate = React.useCallback((opts?: { readonly revalidate?: boolean }): void => {
		if (opts?.revalidate === false) return;
		revalidateRef.current?.();
	}, []);

	const loading = key !== undefined && snapshot.data === undefined && snapshot.error === "loading";

	return { data: snapshot.data, error: snapshot.error, loading, isValidating: snapshot.isValidating, mutate };
}
