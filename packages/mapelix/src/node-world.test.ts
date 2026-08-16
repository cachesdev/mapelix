import { describe, expect, it } from "vitest";

import { openBedrockWorld } from "./node-world.js";

describe("openBedrockWorld", () => {
  it("rejects invalid render concurrency before reading the world", async () => {
    await expect(
      openBedrockWorld({ directory: "/not-read", renderConcurrency: 0 }),
    ).rejects.toThrow("renderConcurrency must be a positive integer");
  });
});
