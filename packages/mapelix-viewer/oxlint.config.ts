import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
  },
  env: {
    browser: true,
    node: true,
  },
  ignorePatterns: ["dist", "coverage", "node_modules"],
});
