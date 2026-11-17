import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const port = Number(process.env.MAPELIX_TEST_PORT ?? 5189);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new RangeError("Invalid test port");

export const TILES_DIRECTORY =
  process.env.MAPELIX_E2E_TILES_DIRECTORY ?? resolve("../../.local/demo-export");

export default defineConfig({
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    {
      name: "phone",
      use: {
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices["Pixel 7"].userAgent,
      },
    },
  ],
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./tests/setup-tiles.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.MAPELIX_TEST_BROWSER,
  },
  // The production build, so first-display times compare like with like.
  webServer: {
    command: "node build/index.js",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { HOST: "127.0.0.1", PORT: String(port), MAPELIX_TILES_DIRECTORY: TILES_DIRECTORY },
  },
});
