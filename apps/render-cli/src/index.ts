#!/usr/bin/env node
import { HELP, parseBatchArguments } from "./arguments.js";

const controller = new AbortController();
let interrupted: NodeJS.Signals | undefined;
const interrupt = (signal: NodeJS.Signals) => {
  interrupted = signal;
  controller.abort();
};
const sigint = () => interrupt("SIGINT");
const sigterm = () => interrupt("SIGTERM");
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
try {
  const args = process.argv.slice(2);
  if (args[0] === "validate") {
    const { runSnapshotValidation } = await import("./snapshot-cli.js");
    process.exitCode = await runSnapshotValidation(args.slice(1), controller.signal);
    if (interrupted !== undefined) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  } else {
    const options = parseBatchArguments(args);
    if (options === "help") process.stdout.write(HELP);
    else {
      const { renderBatch } = await import("@mapelix/core/node/batch");
      const result = await renderBatch({ ...options, signal: controller.signal });
      process.stdout.write(
        `${JSON.stringify({
          manifest: result.manifestPath,
          generation: result.manifest.generation,
          tiles: result.manifest.tileCount,
          pngBytes: result.manifest.pngBytes,
          update: result.update,
          elapsedMs: Math.round(result.elapsedMs),
          peakRssMiB: Math.round(result.peakRssMiB * 100) / 100,
        })}\n`,
      );
    }
  }
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
} finally {
  process.off("SIGINT", sigint);
  process.off("SIGTERM", sigterm);
}
