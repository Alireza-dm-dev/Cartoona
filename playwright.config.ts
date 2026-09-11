import { defineConfig } from "@playwright/test";

// Target app instance. Overridable so a stateful run can point at an app
// started against the guarded disposable project instead of whatever is
// already listening on the default port.
const BASE_URL = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
  },
  webServer: {
    command: "npm run dev",
    url: `${BASE_URL}/login`,
    reuseExistingServer: true,
  },
});
