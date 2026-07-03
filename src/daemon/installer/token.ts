/**
 * PRD-009a: the daemon side of the one-time onboarding token contract (is-AC-9/10).
 *
 * The bootstrap mints the token and writes it to `~/.honeycomb/hive/onboarding-token` at mode
 * 0600 BEFORE the daemon starts (PRD-009d). The daemon reads it LAZILY at request time, not at
 * startup, because on re-entry the daemon may already be running when a fresh bootstrap writes a
 * new token. Comparison is constant time (`crypto.timingSafeEqual`). Completion invalidates the
 * token: the file is deleted and an in-memory flag is set, so state-changing endpoints refuse all
 * requests until a fresh bootstrap mints a new one (is-AC-10). The token is never logged, never
 * returned, and never placed in an error body.
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

/** Build the token store over the injected config seams. */
export function createTokenStore(config: InstallerConfig): TokenStore {
  let invalidated = false;

  const readToken = (): string | null => {
    const raw = config.readTextFile(config.tokenPath);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    isActive(): boolean {
      if (invalidated) return false;
      return config.fileExists(config.tokenPath);
    },
    requireValid(provided): boolean {
      if (invalidated) return false;
      if (provided === null || provided === undefined || provided.length === 0) return false;
      const stored = readToken();
      if (stored === null) return false;
      return constantTimeEquals(stored, provided);
    },
    invalidate(): void {
      invalidated = true;
      config.deleteFile(config.tokenPath);
    }
  };
}
