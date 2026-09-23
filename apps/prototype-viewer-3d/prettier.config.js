/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-svelte"],
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
  semi: true,
  trailingComma: "all",
  overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
};
