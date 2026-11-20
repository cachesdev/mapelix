/** Bounded retry state; a busy server pauses all requests from this terrain streamer. */
export class RequestBackoff {
  private readonly failures = new Map<string, number>();
  private until = 0;

  ready(now: number): boolean {
    return now >= this.until;
  }

  remaining(now: number): number {
    return Math.max(0, this.until - now);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }

  fail(key: string, now: number, response?: Response): void {
    const attempts = Math.min(6, (this.failures.get(key) ?? 0) + 1);
    this.failures.delete(key);
    this.failures.set(key, attempts);
    if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
    let delay = Math.min(30_000, 1000 * 2 ** (attempts - 1));
    const retry = response?.headers.get("retry-after");
    if (retry && response && (response.status === 429 || response.status === 503)) {
      const seconds = Number(retry);
      const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
      if (Number.isFinite(requested)) delay = Math.max(delay, requested);
    }
    this.until = Math.max(this.until, now + delay);
  }

  clear(): void {
    this.failures.clear();
    this.until = 0;
  }
}
