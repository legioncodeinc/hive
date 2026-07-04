import { createTokenStore } from "../../../src/daemon/installer/token.js";
import { createInstallerConfig } from "../../../src/daemon/installer/config.js";

describe("onboarding token dual-path read (mg-AC-9)", () => {
  it("mg-AC-9 reads the legacy token path when the new path is absent", () => {
    const files = new Map<string, string>([["/legacy/onboarding-token", "secret-token"]]);
    const config = createInstallerConfig({
      tokenPath: "/new/onboarding-token",
      legacyTokenPath: "/legacy/onboarding-token",
      fileExists: (path) => files.has(path),
      readTextFile: (path) => files.get(path) ?? null,
      deleteFile: (path) => {
        files.delete(path);
      }
    });

    const store = createTokenStore(config);
    expect(store.requireValid("secret-token")).toBe(true);
  });

  it("mg-AC-10 prefers the new token path when both exist", () => {
    const files = new Map<string, string>([
      ["/new/onboarding-token", "new-token"],
      ["/legacy/onboarding-token", "legacy-token"]
    ]);
    const config = createInstallerConfig({
      tokenPath: "/new/onboarding-token",
      legacyTokenPath: "/legacy/onboarding-token",
      fileExists: (path) => files.has(path),
      readTextFile: (path) => files.get(path) ?? null,
      deleteFile: (path) => {
        files.delete(path);
      }
    });

    const store = createTokenStore(config);
    expect(store.requireValid("new-token")).toBe(true);
    expect(store.requireValid("legacy-token")).toBe(false);
  });

  it("mg-AC-10 a present-but-unreadable new token never falls back to the legacy token", () => {
    const legacyReads: string[] = [];
    const config = createInstallerConfig({
      tokenPath: "/new/onboarding-token",
      legacyTokenPath: "/legacy/onboarding-token",
      // The new-path file EXISTS but its read fails (the EACCES class, not absence).
      fileExists: (path) => path === "/new/onboarding-token" || path === "/legacy/onboarding-token",
      readTextFile: (path) => {
        if (path === "/legacy/onboarding-token") {
          legacyReads.push(path);
          return "legacy-token";
        }
        return null;
      },
      deleteFile: () => {}
    });

    const store = createTokenStore(config);
    expect(store.requireValid("legacy-token")).toBe(false);
    expect(store.isActive()).toBe(false);
    expect(legacyReads).toHaveLength(0);
  });
});
