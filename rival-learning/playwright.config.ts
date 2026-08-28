import { defineConfig, devices } from "@playwright/test";
import { delimiter, dirname } from "node:path";

const e2eDatabasePath =
  process.env.RIVAL_DATABASE_PATH ?? `.data/playwright-${process.pid}.db`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
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
      "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1",
    env: {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      RIVAL_DATABASE_PATH: e2eDatabasePath,
      RIVAL_HOST: "127.0.0.1",
    },
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
