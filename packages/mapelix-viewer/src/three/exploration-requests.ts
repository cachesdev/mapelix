import { RequestBackoff } from "./request-backoff";

export class ExplorationRequestError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with ${status}`);
  }
}

interface Request {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly resolve: (bytes: ArrayBuffer) => void;
  readonly reject: (cause: unknown) => void;
  readonly abort: () => void;
}

/** Shared by caves and discoveries. A slot includes reading the response body. */
export class ExplorationRequests {
  private readonly waiting: Request[] = [];
  private readonly backoff = new RequestBackoff();
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly concurrency = 2) {}

  read(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    if (this.disposed || signal.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const request: Request = {
        url,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(request);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
          if (!this.waiting.length) this.clearTimer();
        },
      };
      this.waiting.push(request);
      signal.addEventListener("abort", request.abort, { once: true });
      this.pump();
    });
  }

  /** Owners abort active caller signals before disposing the shared queue. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    for (const request of this.waiting) {
      request.signal.removeEventListener("abort", request.abort);
      request.reject(new DOMException("Aborted", "AbortError"));
    }
    this.waiting.length = 0;
    this.backoff.clear();
  }

  private pump(): void {
    if (this.disposed || !this.waiting.length) return;
    const delay = this.backoff.remaining(performance.now());
    if (delay > 0) {
      this.timer ??= setTimeout(
        () => {
          this.timer = undefined;
          this.pump();
        },
        Math.min(delay, 2_147_483_647),
      );
      return;
    }
    while (this.active < this.concurrency && this.waiting.length) {
      const request = this.waiting.shift()!;
      request.signal.removeEventListener("abort", request.abort);
      this.active++;
      void this.fetch(request)
        .then(request.resolve, request.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async fetch(request: Request): Promise<ArrayBuffer> {
    let response: Response | undefined;
    try {
      response = await fetch(request.url, { signal: request.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ExplorationRequestError(response.status);
      }
      const bytes = await response.arrayBuffer();
      if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
      this.backoff.succeed(request.url);
      return bytes;
    } catch (cause) {
      if (!this.disposed && !request.signal.aborted)
        this.backoff.fail(request.url, performance.now(), response);
      throw cause;
    }
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
