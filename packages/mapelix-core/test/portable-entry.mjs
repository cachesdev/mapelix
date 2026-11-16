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
  const { surfaceProfile } = await import("../dist/index.js");
  console.log(JSON.stringify(surfaceProfile("nether")));
} finally {
  hooks.deregister();
}
