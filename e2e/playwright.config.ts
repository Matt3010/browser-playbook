import { defineConfig } from "@playwright/test";

/**
 * End-to-end suite. It runs against the Docker test stack started by
 * `scripts/verify.sh` (or `make test-up`), never against external sites.
 */
export default defineConfig({
  testDir: "./specs",
  // Browser sessions are a limited resource in the worker, and several specs
  // assert on shared test-web state, so specs run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: process.env.APP_BASE_URL ?? "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 45_000
  }
});
