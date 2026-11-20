import { defineConfig } from "vite";

/**
 * Builds `src/embed.ts` as one ES module, three.js included, for hosts that load the viewer with
 * a dynamic `import()` from their own origin. The output runs under a strict `script-src 'self'`
 * policy: it has no inline code and no eval. `scripts/embed-css.mjs` then writes its styles as
 * `mapelix-viewer.css`.
 */
export default defineConfig({
  build: {
    outDir: "dist-embed",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: true,
    copyPublicDir: false,
    lib: {
      entry: "src/embed.ts",
      formats: ["es"],
      fileName: () => "mapelix-viewer.js",
    },
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
