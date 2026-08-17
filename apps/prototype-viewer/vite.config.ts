import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  ssr: {
    // Mapelix owns a Node worker entry next to its built module. Keeping the
    // package external preserves that relative URL in adapter-node builds.
    external: ["@mapelix/prototype"],
  },
  plugins: [
    sveltekit({
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      adapter: adapter(),
    }),
  ],
});
