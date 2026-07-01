/**
 * PRD-004a/PRD-005a — the full registered-service-name enumeration (bz-AC-1/bz-AC-2, hr-AC-1),
 * distinct from `parseHivedoctorRegistry`'s narrower honeycomb/hivenectar base-URL resolution.
 */

import { parseRegisteredServiceNames, resolveRegisteredServiceNames } from "../../src/daemon/registry.js";

describe("parseRegisteredServiceNames", () => {
	it("returns EVERY registered name, not just the two proxy-routed daemons", () => {
		const names = parseRegisteredServiceNames(
			JSON.stringify({
				daemons: [
					{ name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/honeycomb.pid" },
					{ name: "hivenectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/hivenectar.pid" },
					{ name: "thehive", healthUrl: "http://127.0.0.1:4853/health", pidPath: "/tmp/thehive.pid" },
				],
			}),
		);
		expect(names).toEqual(["honeycomb", "hivenectar", "thehive"]);
	});

	it("de-duplicates repeated names, preserving first-seen order", () => {
		const names = parseRegisteredServiceNames(
			JSON.stringify({
				daemons: [
					{ name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/a.pid" },
					{ name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/a.pid" },
				],
			}),
		);
		expect(names).toEqual(["honeycomb"]);
	});

	it("degrades to an empty list on malformed JSON, never throwing", () => {
		expect(parseRegisteredServiceNames("{not json")).toEqual([]);
	});

	it("degrades to an empty list when the schema does not match", () => {
		expect(parseRegisteredServiceNames(JSON.stringify({ nope: true }))).toEqual([]);
	});

	it("still returns a name even when its healthUrl is off-loopback (name enumeration is independent of base-URL trust)", () => {
		const names = parseRegisteredServiceNames(
			JSON.stringify({ daemons: [{ name: "evil-svc", healthUrl: "http://evil.example.com/health", pidPath: "/tmp/e.pid" }] }),
		);
		expect(names).toEqual(["evil-svc"]);
	});
});

describe("resolveRegisteredServiceNames", () => {
	it("reads names through an injected file reader", () => {
		const names = resolveRegisteredServiceNames({
			registryPath: "/fake/path.json",
			readFile: () => JSON.stringify({ daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", pidPath: "/tmp/a.pid" }] }),
		});
		expect(names).toEqual(["honeycomb"]);
	});

	it("degrades to an empty list when the registry file is missing/unreadable", () => {
		const names = resolveRegisteredServiceNames({
			readFile: () => {
				throw new Error("ENOENT");
			},
		});
		expect(names).toEqual([]);
	});
});
