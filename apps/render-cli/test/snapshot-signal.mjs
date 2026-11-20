import { pathToFileURL } from "node:url";

// Exercise the handlers on Windows too, where child.kill() forcibly terminates Node.
const [entry, signal, ...args] = process.argv.slice(2);
process.argv = [process.execPath, entry, ...args];
const original = process.on;
process.on = function (event, handler) {
  const result = Reflect.apply(original, this, [event, handler]);
  if (event === "SIGTERM") {
    process.on = original;
    queueMicrotask(() => process.emit(signal));
  }
  return result;
};
await import(pathToFileURL(entry).href);
