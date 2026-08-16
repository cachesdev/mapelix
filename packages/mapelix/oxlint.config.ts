import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
  },
  env: {
    node: true,
  },
  ignorePatterns: ["dist", "coverage", "node_modules"],
});
