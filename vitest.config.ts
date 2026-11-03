import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // Several tests run real stiff integrations; on shared CI runners the
    // slowest take about 6 s, above the 5 s default.
    testTimeout: 30_000,
  },
});
