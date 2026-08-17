import { defineConfig } from "@playwright/test";

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
    command:
      "NODE_OPTIONS=--max-old-space-size=1536 MAPELIX_WORLD_DIRECTORY=/tmp/mapelix-stratos-tmbcraft-pruned-v2 MAPELIX_CACHE_DIRECTORY=/tmp/mapelix-stratos-viewer-cache pnpm run build && NODE_OPTIONS=--max-old-space-size=1536 MAPELIX_WORLD_DIRECTORY=/tmp/mapelix-stratos-tmbcraft-pruned-v2 MAPELIX_CACHE_DIRECTORY=/tmp/mapelix-stratos-viewer-cache pnpm exec vite preview --host 127.0.0.1 --port 4174",
    port: 4174,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
