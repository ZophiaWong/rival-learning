import { defineConfig, devices } from "@playwright/test";
import { delimiter, dirname } from "node:path";

const e2eDatabasePath =
  process.env.RIVAL_DATABASE_PATH ?? `.data/playwright-${process.pid}.db`;
const e2ePort = process.env.RIVAL_E2E_PORT ?? "3000";
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: e2eBaseUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
  webServer: {
    command:
      `node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port ${e2ePort}`,
    env: {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      RIVAL_DATABASE_PATH: e2eDatabasePath,
      RIVAL_HOST: "127.0.0.1",
      RIVAL_TEST_SCRIPTED_ROLE_RUNNER: "1",
    },
    url: e2eBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
