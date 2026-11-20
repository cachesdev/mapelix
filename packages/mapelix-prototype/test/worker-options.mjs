import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";

import { openBedrockWorld } from "../dist/index.js";

const [directory, scenario, count] = process.argv.slice(2);
const posted = [];
const post = Reflect.get(Worker.prototype, "postMessage");
let corrupt = scenario === "clone-error";
Worker.prototype.postMessage = function (message, ...rest) {
  posted.push(message.job?.options);
  if (corrupt) {
    corrupt = false;
    message = { ...message, cannotClone() {} };
  }
  return post.call(this, message, ...rest);
};
const world = await openBedrockWorld({
  directory,
  renderConcurrency: Number(count),
  forceWorkers: true,
});
const coordinates = { dimension: "overworld", z: 2, x: 0, y: 0 };
try {
  if (scenario === "clone-error") {
    await assert.rejects(world.renderTile(coordinates), { name: "DataCloneError" });
    await world.renderTile(coordinates);
  } else if (scenario === "callback") {
    await assert.rejects(
      world.renderTile(coordinates, { resolveBlockStyle: () => [0, 0, 0, 255] }),
      /callbacks/,
    );
    await world.renderTile(coordinates);
  } else {
    const serial = await openBedrockWorld({ directory });
    try {
      const variants = [
        { shadows: false },
        { shadows: true, correctReferenceBugs: true },
        { biomeBlendRadius: 2, includeSurface: true },
        { shadows: false, biomeBlendRadius: 1, correctReferenceBugs: false, includeSurface: true },
      ];
      for (const options of variants) {
        const tile = await world.renderTile(coordinates, options);
        const reference = await serial.renderTile(coordinates, options);
        const digest = (png) => createHash("sha256").update(png).digest("hex");
        assert.equal(digest(tile.png), digest(reference.png));
        assert.deepEqual(tile.surface, reference.surface);
      }
      assert.deepEqual(posted, variants);
    } finally {
      await serial.close();
    }
  }
} finally {
  await world.close();
}
console.log(
  JSON.stringify({
    completed: true,
    jobs: posted.length,
    messagePorts: process.getActiveResourcesInfo().filter((name) => name === "MessagePort").length,
  }),
);
