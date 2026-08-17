import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
  },
  env: {
    node: true,
  },
  ignorePatterns: ["dist", "playwright-report", "test-results", "node_modules"],
});
