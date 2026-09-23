import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  ssr: {
    // The scene package starts worker threads from files next to its built module.
    // Keeping it external preserves those relative URLs in adapter-node builds.
    external: ["@mapelix/scene-prototype"],
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
