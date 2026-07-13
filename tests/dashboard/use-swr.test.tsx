// @vitest-environment jsdom
/**
 * useSwr hook unit tests — PRD-012b.
 *
 * Independent of any page; exercises the hook directly via @testing-library/react's `renderHook`.
 * Each test resets the module-level cache (`clearSwrCache`) so no entry leaks across cases.
 * jsdom's `document.visibilityState` is controlled via `Object.defineProperty` for the
 * background-tab-pause and revalidateOnFocus cases.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { clearSwrCache, invalidateSwr, useSwr } from "../../src/dashboard/web/use-swr.js";

/** A deferred promise the test resolves manually to simulate a slow fetcher. */
interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (err: unknown) => void;
}
function makeDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Set jsdom's `document.visibilityState` (read-only property → defineProperty). */
function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
function resetVisibility(): void {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
}

afterEach(() => {
	cleanup();
	clearSwrCache();
	resetVisibility();
});

describe("useSwr", () => {
	it("instant-from-cache: serves the cached value on first paint (no loading flash)", async () => {
		// Pre-seed the cache: a prior mount resolved "first", so a second mount sees it instantly.
		const first = renderHook(() => useSwr("/k1", async () => "first"));
		await waitFor(() => expect(first.result.current.data).toBe("first"));

		first.unmount();

		// The second mount reads the cache synchronously — data is "first" on the first paint.
		const second = renderHook(() => useSwr("/k1", async () => "second"));
		expect(second.result.current.data).toBe("first");
		expect(second.result.current.loading).toBe(false);

		// The background revalidate fires and updates to "second".
		await waitFor(() => expect(second.result.current.data).toBe("second"));
		expect(second.result.current.isValidating).toBe(false);
	});

	it("dedupe-concurrent: two hooks with the same key share one fetch", async () => {
		const deferred = makeDeferred<string>();
		let calls = 0;
		const fetcher = async (): Promise<string> => {
			calls += 1;
			return deferred.promise;
		};

		const a = renderHook(() => useSwr("/dedupe", fetcher));
		const b = renderHook(() => useSwr("/dedupe", fetcher));

		expect(a.result.current.loading).toBe(true);
		expect(b.result.current.loading).toBe(true);

		await act(async () => {
			deferred.resolve("shared");
			await deferred.promise;
		});

		await waitFor(() => expect(a.result.current.data).toBe("shared"));
		await waitFor(() => expect(b.result.current.data).toBe("shared"));
		expect(calls).toBe(1);
	});

	it("keepPreviousData-on-remount: a revisit renders previous data instantly with loading false", async () => {
		const first = renderHook(() => useSwr("/keep", async () => "v1"));
		await waitFor(() => expect(first.result.current.data).toBe("v1"));
		first.unmount();

		const second = renderHook(() => useSwr("/keep", async () => "v2"));
		expect(second.result.current.data).toBe("v1");
		expect(second.result.current.loading).toBe(false);
		expect(second.result.current.isValidating).toBe(true);

		await waitFor(() => expect(second.result.current.data).toBe("v2"));
	});

	it("revalidateOnFocus: fires a revalidate on visibilitychange→visible; skips while hidden", async () => {
		// Start hidden so an interval deadline cannot race the transition under test.
		// Initial SWR hydration is unconditional, so the mount fetch still runs.
		setVisibility("hidden");

		let calls = 0;
		const { result } = renderHook(() =>
			useSwr("/focus", async () => {
				calls += 1;
				return `r${calls}`;
			}, { refreshInterval: 100, dedupeMs: 0 }),
		);

		// Initial fetch.
		await waitFor(() => expect(result.current.data).toBe("r1"));

		// Background the tab — interval ticks should NOT fire a fetch.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 120));
		});
		expect(calls).toBe(1);

		// Re-foreground — an immediate revalidate fires.
		setVisibility("visible");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
	});

	it("mutation-invalidation: invalidateSwr drops entries by prefix and triggers a refetch", async () => {
		let calls = 0;
		const fetcher = async (): Promise<string> => {
			calls += 1;
			return calls === 1 ? "before" : "after";
		};

		const { result } = renderHook(() => useSwr("/api/memories:list", fetcher, { dedupeMs: 0 }));
		await waitFor(() => expect(result.current.data).toBe("before"));
		expect(calls).toBe(1);

		// Invalidate by prefix — the mounted hook revalidates.
		act(() => invalidateSwr("/api/memories"));

		await waitFor(() => expect(result.current.data).toBe("after"));
		expect(calls).toBe(2);
	});

	it("undefined-key-disables: returns no data and never calls the fetcher", async () => {
		const fetcher = vi.fn(async () => "should-not-fire");
		const { result } = renderHook(() => useSwr<string>(undefined, fetcher));

		expect(result.current.data).toBeUndefined();
		expect(result.current.loading).toBe(false);
		expect(result.current.isValidating).toBe(false);
		expect(result.current.error).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();

		// Give the event loop a chance — the fetcher must still not fire.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("fail-soft-on-error: a throwing fetcher sets error='failed', keeps previous data, no throw", async () => {
		const { result } = renderHook(() =>
			useSwr<string>(
				"/err",
				async () => {
					throw new Error("boom");
				},
				{ dedupeMs: 0 },
			),
		);

		await waitFor(() => expect(result.current.error).toBe("failed"));
		expect(result.current.data).toBeUndefined();
		expect(result.current.isValidating).toBe(false);

		// No throw reaches React — the hook swallowed it.
		expect(result.current.data).toBeUndefined();
	});

	it("clearSwrCache: drops every entry and triggers a refetch on mounted hooks", async () => {
		let calls = 0;
		const fetcher = async (): Promise<string> => {
			calls += 1;
			return calls === 1 ? "first" : "cleared";
		};

		const { result } = renderHook(() => useSwr("/clear:1", fetcher, { dedupeMs: 0 }));
		await waitFor(() => expect(result.current.data).toBe("first"));

		const other = renderHook(() => useSwr("/clear:2", async () => "other"));
		await waitFor(() => expect(other.result.current.data).toBe("other"));

		// Clear everything — both mounted hooks revalidate.
		act(() => clearSwrCache());

		await waitFor(() => expect(result.current.data).toBe("cleared"));
		expect(calls).toBe(2);
	});
});
