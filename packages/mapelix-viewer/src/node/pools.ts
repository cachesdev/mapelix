import type { BuiltRegion, Dimension, RegionRequest, SceneWorld } from "@mapelix/scene-prototype";
import type { DiscoveryRequest } from "@mapelix/scene-prototype/discoveries";

export interface DimensionPoolsOptions {
  /** Opens one dimension's world and its builder threads. */
  readonly open: (dimension: Dimension) => Promise<SceneWorld>;
  /** Builds that may run at once across every dimension. */
  readonly permits: number;
  /** A dimension's builders are closed after this long without a build. 0 keeps them. */
  readonly idleMilliseconds: number;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

/** An idle dimension closes this soon once another dimension opens. */
const SWITCH_IDLE_MILLISECONDS = 5_000;

interface Pool {
  readonly world: Promise<SceneWorld>;
  active: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The engine fixes one dimension per world and worker pool. Visiting the Overworld,
 * the Nether and the End would therefore keep three sets of builder threads. This
 * shares one build budget between them and closes a dimension's threads once it has
 * been idle for a while, or a few seconds after another dimension opens, so memory
 * stays close to that of a single dimension. A dimension in use is never closed.
 * Background work (the prewarm) gets a builder only when no visitor is waiting.
 */
export class DimensionPools {
  private readonly options: DimensionPoolsOptions;
  private readonly pools = new Map<Dimension, Pool>();
  private readonly waiting: (() => void)[] = [];
  private readonly waitingBackground: (() => void)[] = [];
  private running = 0;
  private closed = false;

  constructor(options: DimensionPoolsOptions) {
    if (!Number.isSafeInteger(options.permits) || options.permits < 1) {
      throw new RangeError("permits must be a positive integer");
    }
    this.options = options;
  }

  /** Opens a dimension now, such as the first one at start-up to prove the snapshot reads. */
  world(dimension: Dimension): Promise<SceneWorld> {
    return this.pool(dimension).world;
  }

  get openDimensions(): Dimension[] {
    return [...this.pools.keys()];
  }

  build(
    dimension: Dimension,
    request: RegionRequest,
    signal: AbortSignal,
    background = false,
  ): Promise<BuiltRegion> {
    return this.run(dimension, signal, background, (world) => world.buildRegion(request, signal));
  }

  /** The all-height discovery index of one 32-block tile. */
  discoveries(
    dimension: Dimension,
    tile: DiscoveryRequest,
    signal: AbortSignal,
    background = false,
  ): Promise<BuiltRegion> {
    return this.run(dimension, signal, background, (world) => world.buildDiscoveries(tile, signal));
  }

  private async run(
    dimension: Dimension,
    signal: AbortSignal,
    background: boolean,
    work: (world: SceneWorld) => Promise<BuiltRegion>,
  ): Promise<BuiltRegion> {
    await this.acquire(signal, background);
    const pool = this.pool(dimension);
    pool.active += 1;
    if (pool.idleTimer !== undefined) clearTimeout(pool.idleTimer);
    pool.idleTimer = undefined;
    try {
      return await work(await pool.world);
    } finally {
      pool.active -= 1;
      this.release();
      if (pool.active === 0) this.scheduleClose(dimension, pool);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pools = [...this.pools.values()];
    this.pools.clear();
    for (const pool of pools) if (pool.idleTimer !== undefined) clearTimeout(pool.idleTimer);
    await Promise.allSettled(pools.map(async (pool) => (await pool.world).close()));
  }

  private pool(dimension: Dimension): Pool {
    if (this.closed) throw new Error("The region builders are shut down");
    let pool = this.pools.get(dimension);
    if (pool === undefined) {
      const world = this.options.open(dimension);
      const opened: Pool = { world, active: 0, idleTimer: undefined };
      pool = opened;
      // Another dimension's idle threads go soon, unless it is used again meanwhile.
      for (const [other, idle] of this.pools) {
        if (idle.active === 0) this.scheduleClose(other, idle, SWITCH_IDLE_MILLISECONDS);
      }
      this.pools.set(dimension, opened);
      world.catch(() => {
        if (this.pools.get(dimension) === opened) this.pools.delete(dimension);
      });
      this.options.onEvent?.("pool.opened", { dimension });
    }
    return pool;
  }

  private scheduleClose(dimension: Dimension, pool: Pool, sooner?: number): void {
    const idle = this.options.idleMilliseconds;
    if (idle <= 0 || this.closed) return;
    const delay = sooner === undefined ? idle : Math.min(idle, sooner);
    if (pool.idleTimer !== undefined) clearTimeout(pool.idleTimer);
    pool.idleTimer = setTimeout(() => {
      if (pool.active !== 0 || this.pools.get(dimension) !== pool) return;
      this.pools.delete(dimension);
      this.options.onEvent?.("pool.closed", { dimension });
      void pool.world.then((world) => world.close()).catch(() => undefined);
    }, delay);
    pool.idleTimer.unref?.();
  }

  private acquire(signal: AbortSignal, background: boolean): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    const queue = background ? this.waitingBackground : this.waiting;
    const nobodyFirst = background ? this.waiting.length === 0 : true;
    if (this.running < this.options.permits && nobodyFirst) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.running += 1;
        resolve();
      };
      const onAbort = (): void => {
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(grant);
    });
  }

  private release(): void {
    this.running -= 1;
    (this.waiting.shift() ?? this.waitingBackground.shift())?.();
  }
}

function abortError(): Error {
  return new DOMException("The region request was cancelled", "AbortError");
}
