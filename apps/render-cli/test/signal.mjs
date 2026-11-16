import { pathToFileURL } from "node:url";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the portable handler on Windows too, where kill() forcibly terminates processes.
const [entry, ...args] = process.argv.slice(2);
process.argv = [process.execPath, entry, ...args];
const pending = import(pathToFileURL(entry).href);
const output = args[args.indexOf("--output") + 1];
let accepted = false;
for (let attempt = 0; attempt < 400; attempt++) {
  try {
    await lstat(join(output, ".mapelix.lock"));
    accepted = true;
    break;
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  await delay(10);
}
if (!accepted) throw new Error("CLI did not acquire its output lock");
process.emit("SIGINT");
await pending;
