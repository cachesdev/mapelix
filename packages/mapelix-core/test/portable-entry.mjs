import { builtinModules, registerHooks } from "node:module";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("node:") || builtinModules.includes(specifier)) {
      throw new Error(`The portable entry imported a Node builtin: ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});
try {
  const { surfaceProfile, mapPixelsPerBlock, mapTileBounds } = await import("../dist/index.js");
  const { BEDROCK_BLOCK_COLORS } = await import("@mapelix/core/appearance");
  console.log(
    JSON.stringify({
      ...surfaceProfile("nether"),
      appearanceEntries: Object.keys(BEDROCK_BLOCK_COLORS).length,
      overviewPixelsPerBlock: mapPixelsPerBlock(-4),
      overviewMinX: mapTileBounds({ dimension: "overworld", z: -4, x: -1, y: 0 }).minX,
    }),
  );
} finally {
  hooks.deregister();
}
