import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    globals: true,
    testTimeout: 10_000,
    setupFiles: ["tests/setup/isolate-home.ts"]
  }
});
