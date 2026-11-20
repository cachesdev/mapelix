/** Too many distinct builds are already waiting. The client should retry later. */
export class OverloadedError extends Error {
  override readonly name = "OverloadedError";
}

interface Flight<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiters: number;
}

/**
 * Shares one build between every caller that asks for the same key, and bounds how
 * many distinct builds may be queued or running. A build every caller abandoned is
 * aborted, so a worker never spends time on a result nobody waits for.
 */
export class Flights<T> {
  private readonly maxPending: number;
  private readonly flights = new Map<string, Flight<T>>();
  rejected = 0;

  constructor(maxPending: number) {
    this.maxPending = maxPending;
  }

  get size(): number {
    return this.flights.size;
  }

  get limit(): number {
    return this.maxPending;
  }

  join(key: string, start: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    let flight = this.flights.get(key);
    // A build every earlier caller abandoned is being dropped: start a fresh one.
    if (flight?.controller.signal.aborted === true) flight = undefined;
    if (flight === undefined) {
      if (this.flights.size >= this.maxPending) {
        this.rejected += 1;
        throw new OverloadedError("Too many builds are waiting; retry shortly");
      }
      const controller = new AbortController();
      const promise = start(controller.signal);
      const started: Flight<T> = { controller, promise, waiters: 0 };
      flight = started;
      this.flights.set(key, started);
      void promise
        .catch(() => undefined)
        .finally(() => {
          if (this.flights.get(key) === started) this.flights.delete(key);
        });
    }
    return wait(flight, signal);
  }
}

/** Resolves with the shared build, or rejects for this caller alone when it aborts. */
function wait<T>(flight: Flight<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  flight.waiters += 1;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      flight.waiters -= 1;
      // Nobody wants it any more: drop the build if no worker has started it.
      if (flight.waiters === 0) flight.controller.abort();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        resolve(result);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/** Least recently used byte arrays under a byte budget and an entry count. */
export class ByteLru {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Uint8Array>();
  private total = 0;

  constructor(maxBytes: number, maxEntries = Number.POSITIVE_INFINITY) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.maxBytes || this.maxEntries < 1) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) this.total -= previous.byteLength;
    this.entries.delete(key);
    this.entries.set(key, value);
    this.total += value.byteLength;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
      this.total -= entry.byteLength;
    }
  }
}

export function abortError(): Error {
  return new DOMException("The request was cancelled", "AbortError");
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
