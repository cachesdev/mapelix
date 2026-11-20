import { describe, expect, it, vi } from "vitest";
import { RequestBackoff } from "./request-backoff";

describe("bounded terrain retry backoff", () => {
  it("honors Retry-After for the entire streamer, even after another request succeeds", () => {
    const backoff = new RequestBackoff();
    backoff.fail("a", 500, new Response(null, { status: 429, headers: { "retry-after": "5" } }));
    backoff.succeed("b");
    expect(backoff.ready(5499)).toBe(false);
    expect(backoff.ready(5500)).toBe(true);
    backoff.clear();
    expect(backoff.ready(0)).toBe(true);
  });

  it("backs off repeated failures, tolerates invalid headers and caps retained keys", () => {
    const backoff = new RequestBackoff();
    backoff.fail("a", 0);
    expect(backoff.ready(999)).toBe(false);
    backoff.fail(
      "a",
      1000,
      new Response(null, { status: 503, headers: { "retry-after": "invalid" } }),
    );
    expect(backoff.ready(2999)).toBe(false);
    expect(backoff.ready(3000)).toBe(true);
    for (let i = 0; i < 1000; i++) backoff.fail(String(i), 3000);
    expect((Reflect.get(backoff, "failures") as Map<string, number>).size).toBe(256);
  });

  it("accepts an HTTP-date Retry-After", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-13T17:00:00Z"));
    try {
      const backoff = new RequestBackoff();
      backoff.fail(
        "a",
        100,
        new Response(null, {
          status: 503,
          headers: { "retry-after": "Fri, 13 Nov 2026 17:00:06 GMT" },
        }),
      );
      expect(backoff.ready(6099)).toBe(false);
      expect(backoff.ready(6100)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
