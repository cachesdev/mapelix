import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "pnpm run build && pnpm run preview",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
