import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorationRequests } from "./exploration-requests";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared cave/discovery requests", () => {
  it("holds at most two slots, including body download, and removes queued aborted requests", async () => {
    const bodies: ((bytes: ArrayBuffer) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          arrayBuffer: () =>
            new Promise((resolve) => {
              bodies.push(resolve);
            }),
        }) as Response,
    );
    vi.stubGlobal("fetch", fetcher);
    const requests = new ExplorationRequests();
    const a = new AbortController(),
      b = new AbortController(),
      c = new AbortController();
    const first = requests.read("/regions/a.bin", a.signal);
    const second = requests.read("/discoveries/b.bin", b.signal);
    const third = requests.read("/regions/c.bin", c.signal);
    const cancelled = expect(third).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    c.abort();
    await cancelled;
    bodies[0]!(new ArrayBuffer(4));
    bodies[1]!(new ArrayBuffer(4));
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    requests.dispose();
  });

  it.each([429, 503])("honors a %i Retry-After across terrain and discoveries", async (status) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status, headers: { "retry-after": "4" } }))
      .mockResolvedValue(new Response(new ArrayBuffer(4)));
    vi.stubGlobal("fetch", fetcher);
    const requests = new ExplorationRequests(1);
    const first = requests.read("/regions/a.bin", new AbortController().signal);
    const failed = expect(first).rejects.toMatchObject({ status });
    const second = requests.read("/discoveries/b.bin", new AbortController().signal);
    await failed;
    await flush();
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetcher).toHaveBeenCalledTimes(2);
    requests.dispose();
  });

  it("clears delayed requests and timers during disposal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const requests = new ExplorationRequests(1);
    const first = requests.read("/a", new AbortController().signal);
    const failure = expect(first).rejects.toMatchObject({ status: 429 });
    const second = requests.read("/b", new AbortController().signal);
    const cancelled = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await failure;
    await flush();
    requests.dispose();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
