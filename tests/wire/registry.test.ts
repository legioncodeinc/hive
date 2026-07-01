import {
  baseUrlFromHealthUrl,
  parseHivedoctorRegistry,
  resolveDaemonBases
} from "../../src/daemon/registry.js";

describe("hivedoctor daemon registry", () => {
  it("c-AC-1 derives daemon bases from healthUrl values", () => {
    const bases = parseHivedoctorRegistry(
      JSON.stringify({
        daemons: [
          { name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health", pidPath: "/tmp/honeycomb.pid" },
          { name: "hivenectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/hivenectar.pid" }
        ]
      })
    );

    expect(bases).toEqual({
      honeycomb: "http://127.0.0.1:4850",
      hivenectar: "http://127.0.0.1:4854"
    });
  });

  it("c-AC-1 preserves a healthUrl path prefix while stripping only /health", () => {
    expect(baseUrlFromHealthUrl("http://127.0.0.1:4850/workload/health")).toBe("http://127.0.0.1:4850/workload");
  });

  it("c-AC-3 treats missing or malformed registry content as default daemon bases", () => {
    expect(parseHivedoctorRegistry("{")).toEqual({});
    expect(resolveDaemonBases({ readFile: () => { throw new Error("missing registry"); } })).toEqual({
      honeycomb: "http://127.0.0.1:3850",
      hivenectar: "http://127.0.0.1:3854"
    });
  });

  it("security: rejects a non-loopback healthUrl rather than trusting it as a daemon base", () => {
    expect(baseUrlFromHealthUrl("http://evil.example.com:4850/health")).toBeNull();

    const bases = parseHivedoctorRegistry(
      JSON.stringify({
        daemons: [
          { name: "honeycomb", healthUrl: "http://evil.example.com/health", pidPath: "/tmp/honeycomb.pid" },
          { name: "hivenectar", healthUrl: "http://127.0.0.1:4854/health", pidPath: "/tmp/hivenectar.pid" }
        ]
      })
    );
    // The tampered honeycomb entry is dropped entirely — resolveDaemonBases falls back to the
    // documented loopback default for it rather than ever handing out an attacker-controlled base.
    expect(bases).toEqual({ hivenectar: "http://127.0.0.1:4854" });
  });
});
