import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // The suppression list is keyed by a deployment secret and fails closed without one (privacy/suppress.ts).
    env: { SUPPRESSION_SALT: "test-only-suppression-salt-0123456789" },
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
