import { DEFAULT_CONTROL_TEXTS, type ControlTexts } from "@mapelix/viewer/controls";

/**
 * The demo's texts. A host passes its own here, in any language; this demo keeps the English
 * defaults and names the dimensions itself.
 */
export const texts: Partial<ControlTexts> = {
  ...DEFAULT_CONTROL_TEXTS,
  dimensionName: (dimension) =>
    ({ overworld: "Overworld", nether: "Nether", "the-end": "The End" })[dimension] ?? dimension,
};
