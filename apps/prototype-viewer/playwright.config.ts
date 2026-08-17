import { defineConfig } from "@playwright/test";

const worldDirectory =
  process.env.MAPELIX_WORLD_DIRECTORY ?? "/tmp/mapelix-stratos-tmbcraft-pruned-v2";
const cacheDirectory = process.env.MAPELIX_CACHE_DIRECTORY ?? "/tmp/mapelix-stratos-viewer-cache";
const renderWorkers = process.env.MAPELIX_RENDER_WORKERS ?? "2";

export default defineConfig({
  expect: {
    timeout: 120_000,
  },
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  timeout: 180_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "pnpm run build && pnpm exec vite preview --host 127.0.0.1 --port 4174",
    env: {
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=1536",
      MAPELIX_WORLD_DIRECTORY: worldDirectory,
      MAPELIX_CACHE_DIRECTORY: cacheDirectory,
      MAPELIX_RENDER_WORKERS: renderWorkers,
    },
    port: 4174,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
