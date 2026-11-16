import { describe, expect, it } from "vitest";
import { BEDROCK_BLOCK_COLORS as sharedCatalog, BEDROCK_BLOCK_IDS } from "@mapelix/core/appearance";
import { BEDROCK_BLOCK_COLORS as compatibilityCatalog } from "./bedrock-colors.js";

describe("shared appearance ownership", () => {
  it("uses the same catalog object through the original scene import path", () => {
    expect(compatibilityCatalog).toBe(sharedCatalog);
    expect(Object.keys(sharedCatalog)).toHaveLength(1276);
    expect(BEDROCK_BLOCK_IDS).toHaveLength(1466);
  });
});
