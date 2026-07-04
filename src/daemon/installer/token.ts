/**
 * PRD-009a: the daemon side of the one-time onboarding token contract (is-AC-9/10).
 *
 * The bootstrap mints the token and writes it to the hive onboarding-token path at mode 0600 BEFORE
 * the daemon starts (PRD-009d). During the fleet-root migration window the daemon also reads the
 * legacy path when the new path is absent (mg-AC-9). The daemon reads the token LAZILY at request
 * time, not at startup, because on re-entry the daemon may already be running when a fresh bootstrap
 * writes a new token. Comparison is constant time (`crypto.timingSafeEqual`). Completion invalidates
 * the token: whichever path served it is deleted and an in-memory flag is set, so state-changing
 * endpoints refuse all requests until a fresh bootstrap mints a new one (is-AC-10). The token is
 * never logged, never returned, and never placed in an error body.
 */

import { timingSafeEqual } from "node:crypto";

import type { InstallerConfig } from "./config.js";

/** Constant-time string comparison. Length is compared first (timingSafeEqual requires equal length). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a same-length comparison so a length mismatch is not a faster reject path.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** The token gate: whether onboarding is active, whether a presented token is valid, and invalidation. */
export interface TokenStore {
  /** True while a token file exists and has not been invalidated (an active onboarding session). */
  isActive(): boolean;
  /** True iff `provided` matches the on-disk token in constant time and the token is not invalidated. */
  requireValid(provided: string | null | undefined): boolean;
  /** Invalidate the token: delete the file and set the in-memory flag (idempotent). */
  invalidate(): void;
}

function readTrimmed(config: InstallerConfig, path: string): string | null {
  const raw = config.readTextFile(path);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * mg-AC-9/10: new path first, legacy path second, and the fallback is ABSENCE-triggered only.
 * When the new-path file EXISTS, the legacy path is never consulted, even if the new file is
 * unreadable or empty (that reads as "no valid token", never as stale legacy data).
 */
function resolveTokenPathAndValue(config: InstallerConfig): { readonly path: string; readonly value: string } | null {
  if (config.fileExists(config.tokenPath)) {
    const primary = readTrimmed(config, config.tokenPath);
    return primary === null ? null : { path: config.tokenPath, value: primary };
  }

  const legacy = readTrimmed(config, config.legacyTokenPath);
  if (legacy !== null) return { path: config.legacyTokenPath, value: legacy };

  return null;
}

/** Build the token store over the injected config seams. */
export function createTokenStore(config: InstallerConfig): TokenStore {
  let invalidated = false;
  let activePath: string | null = null;

  return {
    isActive(): boolean {
      if (invalidated) return false;
      return resolveTokenPathAndValue(config) !== null;
    },
    requireValid(provided): boolean {
      if (invalidated) return false;
      if (provided === null || provided === undefined || provided.length === 0) return false;
      const resolved = resolveTokenPathAndValue(config);
      if (resolved === null) return false;
      activePath = resolved.path;
      return constantTimeEquals(resolved.value, provided);
    },
    invalidate(): void {
      invalidated = true;
      config.deleteFile(config.tokenPath);
      config.deleteFile(config.legacyTokenPath);
      if (activePath !== null) {
        config.deleteFile(activePath);
      }
    }
  };
}
