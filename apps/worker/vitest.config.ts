import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. The integration tests under test/ need a real database
    // and run through vitest.integration.config.ts.
    include: ["src/**/*.test.ts"]
  }
});
