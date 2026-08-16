import { describe, expect, it } from "vitest";

import { prototypeVersion } from "./index.js";

describe("prototype package", () => {
  it("exports its prototype version", () => {
    expect(prototypeVersion).toBe("0.0.0");
  });
});
