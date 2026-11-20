import { createRequire, syncBuiltinESMExports, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [entry, directory, scenario] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const promises = require("node:fs/promises");
if (scenario === "readonly" || scenario === "cli-readonly") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        /node-world\.js$|node-worker-pool\.js$|chunk-surface-store\.js$|surface-appearance\.js$|@mapelix\/core\/node\/batch$/.test(
          specifier,
        )
      )
        throw new Error(`Unexpected rendering or cache import: ${specifier}`);
      return nextResolve(specifier, context);
    },
  });
  const forbidden = () => {
    throw new Error("Unexpected filesystem mutation");
  };
  for (const name of [
    "writeFile",
    "appendFile",
    "chmod",
    "chown",
    "lchmod",
    "lchown",
    "fchmod",
    "fchown",
    "mkdir",
    "mkdtemp",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "link",
    "symlink",
    "truncate",
    "ftruncate",
    "utimes",
    "lutimes",
    "copyFile",
    "cp",
  ]) {
    if (typeof fs[name] === "function") fs[name] = forbidden;
    if (typeof fs[`${name}Sync`] === "function") fs[`${name}Sync`] = forbidden;
    if (typeof promises[name] === "function") promises[name] = forbidden;
  }
  for (const [object, name] of [
    [fs, "openSync"],
    [promises, "open"],
  ]) {
    const original = object[name];
    object[name] = function (path, flags, ...rest) {
      if (flags !== "r" && flags !== 0) forbidden();
      if (String(path).endsWith("038514.ldb")) throw new Error("Inactive table was opened");
      return Reflect.apply(original, this, [path, flags, ...rest]);
    };
  }
}
if (scenario === "changed") {
  const original = promises.open;
  let reads = 0;
  promises.open = async function (path, ...args) {
    if (String(path) === join(directory, "db", "000003.ldb") && ++reads === 2) {
      const bytes = await promises.readFile(path);
      bytes[0] ^= 1;
      await promises.writeFile(path, bytes);
    }
    return Reflect.apply(original, this, [path, ...args]);
  };
}
syncBuiltinESMExports();
if (scenario === "cli-readonly") {
  process.argv = [process.execPath, entry, "validate", "--world", directory];
  await import(pathToFileURL(entry).href);
} else {
  const { validateSnapshot } = await import(pathToFileURL(entry).href);
  const result = await validateSnapshot(directory);
  process.stdout.write(JSON.stringify(result) + "\n");
}
