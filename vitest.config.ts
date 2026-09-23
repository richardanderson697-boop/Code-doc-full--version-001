import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Redirects data/ and uploaded_project/ into a temp dir before any module
    // is imported, so a test run cannot touch real runtime state.
    setupFiles: ["./test/setup-env.ts"],
    // The vendored PreFlight engine parses large probe tables on import.
    testTimeout: 30000,
  },
});
