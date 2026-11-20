import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
  semi: true,
  trailingComma: "all",
  sortPackageJson: false,
  ignorePatterns: ["dist/**", "coverage/**", "node_modules/**"],
});
