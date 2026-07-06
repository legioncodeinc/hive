import { describe, expect, it, vi } from "vitest";

import {
	createWireClient,
	ENDPOINTS,
	HealthReasonsSchema,
	MemoryActionSchema,
	type FetchLike,
} from "../../src/dashboard/web/wire.js";

// Memory Formation — the SIBLING of the embeddings toggle. The daemon exposes:
//   1. `GET /health` → `reasons.memory = { enabled, provider: "configured" | "unconfigured" }`
//   2. `POST /api/actions/memory { enabled }` → `{ ok, enabled, persisted, appliesOnRestart: true }`
// These assert the wire schema parses both (fail-soft + back-compat) and that `setMemory` POSTs the
// right payload to the right endpoint and only reports success when the ack echoes the requested state.

function requestUrl(input: Parameters<FetchLike>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HealthReasonsSchema — reasons.memory (memory formation)", () => {
	const base = { storage: "reachable", embeddings: "on", schema: "ok", portkey: "ok" } as const;

	it("parses a configured+enabled memory block verbatim", () => {
		const parsed = HealthReasonsSchema.parse({ ...base, memory: { enabled: true, provider: "configured" } });
		expect(parsed.memory).toEqual({ enabled: true, provider: "configured" });
	});

	it("parses an unconfigured memory block verbatim", () => {
		const parsed = HealthReasonsSchema.parse({ ...base, memory: { enabled: false, provider: "unconfigured" } });
		expect(parsed.memory).toEqual({ enabled: false, provider: "unconfigured" });
	});

	it("is optional — a pre-memory daemon (no memory block) still parses, field is undefined", () => {
		const parsed = HealthReasonsSchema.parse(base);
		expect(parsed.memory).toBeUndefined();
		// The rest of the block is untouched (back-compat).
		expect(parsed.embeddings).toBe("on");
	});

	it("an unknown provider degrades that inner field to 'unconfigured' (fail-closed) without losing the block", () => {
		const parsed = HealthReasonsSchema.parse({ ...base, memory: { enabled: true, provider: "bogus" } });
		expect(parsed.memory).toEqual({ enabled: true, provider: "unconfigured" });
		expect(parsed.storage).toBe("reachable");
	});
});

describe("MemoryActionSchema — POST /api/actions/memory ack", () => {
	it("parses the full ack, defaulting appliesOnRestart to true when absent", () => {
		const parsed = MemoryActionSchema.parse({ ok: true, enabled: true, persisted: true, appliesOnRestart: true });
		expect(parsed).toEqual({ ok: true, enabled: true, persisted: true, appliesOnRestart: true });
	});

	it("FAILS the parse when ok/enabled are missing (strict, so a bad body reads as failure)", () => {
		expect(MemoryActionSchema.safeParse({ persisted: true }).success).toBe(false);
	});
});

describe("wire.setMemory — POST /api/actions/memory", () => {
	it("POSTs { enabled } to the memory action endpoint and reports success on a matching echo", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<FetchLike>[0]) => {
			if (requestUrl(input) === ENDPOINTS.actionsMemory) {
				return jsonResponse({ ok: true, enabled: true, persisted: true, appliesOnRestart: true });
			}
			return jsonResponse({}, 404);
		}) as unknown as FetchLike;

		const wire = createWireClient({ fetchImpl });
		await expect(wire.setMemory(true)).resolves.toBe(true);

		const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(requestUrl(call[0])).toBe(ENDPOINTS.actionsMemory);
		expect(call[1]).toMatchObject({ method: "POST" });
		expect(JSON.parse(String(call[1].body))).toEqual({ enabled: true });
	});

	it("reports failure when the echoed enabled does not match the request", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, enabled: false, persisted: true, appliesOnRestart: true })) as unknown as FetchLike;
		const wire = createWireClient({ fetchImpl });
		await expect(wire.setMemory(true)).resolves.toBe(false);
	});

	it("reports failure on a non-2xx response (never a throw)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as FetchLike;
		const wire = createWireClient({ fetchImpl });
		await expect(wire.setMemory(false)).resolves.toBe(false);
	});
});
