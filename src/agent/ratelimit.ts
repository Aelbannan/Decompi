/**
 * Per-model request pacing (SPEC §11): a `RateLimiter` keyed by model-directory
 * name enforces each model's `rpm` — one request per `60_000 / rpm` ms, never
 * in bursts — via a per-model promise chain. A `ModelRegistry` (name → rpm)
 * feeds the pacer; `rpm <= 0` (or an unregistered name) means unlimited:
 * `acquire` resolves immediately.
 *
 * Pacing is intentionally keyed by model, not global: a 20-rpm provider must
 * not throttle a 1,000-rpm sibling run sharing the daemon (SPEC §11,
 * "per-model pacing, not one global pacer").
 *
 * `now()` and `sleep()` are injectable for determinism: tests use a fake clock
 * (advanceable `now` + no-op `sleep`) so the exact inter-request gaps are
 * asserted without real timers.
 */

/** Per-model request budget: `rpm` names the requests-per-minute cap. */
export interface ModelRegistry {
  /**
   * Requests per minute allowed for `model`. Non-positive (or unknown) models
   * are unlimited.
   */
  rpm(model: string): number;
}

/** In-memory `ModelRegistry` fed from `{ name: rpm }` maps (e.g. models.json). */
export class StaticModelRegistry implements ModelRegistry {
  private readonly rpms = new Map<string, number>();

  constructor(models?: Record<string, number> | Map<string, number>) {
    if (models) {
      const entries = models instanceof Map ? models : Object.entries(models);
      for (const [name, rpm] of entries) this.rpms.set(name, rpm);
    }
  }

  /** Register (or overwrite) a model's rpm cap. `rpm <= 0` = unlimited. */
  register(name: string, rpm: number): this {
    this.rpms.set(name, rpm);
    return this;
  }

  rpm(model: string): number {
    return this.rpms.get(model) ?? 0;
  }
}

/** Options for `RateLimiter`; both injectable for deterministic tests. */
export interface RateLimiterOptions {
  /** Wall-clock source (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep implementation. Defaults to `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-model request pacer. `acquire(model)` resolves only once the model's
 * pacing window is open; concurrent callers for the same model serialize on a
 * per-model promise chain, so requests leave at most one per `60_000/rpm` ms
 * (no bursts). Different models never block each other.
 */
export class RateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Per-model acquire chains: each acquire waits for the previous one to release. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Per-model absolute time at which the next request may fire. */
  private readonly nextAt = new Map<string, number>();
  /**
   * `now()` at each release, per model, in acquire order. Observability aid
   * (tests/logs); never used for pacing decisions.
   */
  readonly releases = new Map<string, number[]>();

  constructor(
    private readonly registry: ModelRegistry,
    opts: RateLimiterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Wait until a request for `model` is within its rpm window, then mark the
   * slot consumed. Resolves immediately for unlimited models (`rpm <= 0`).
   */
  async acquire(model: string): Promise<void> {
    const rpm = this.registry.rpm(model);
    if (!Number.isFinite(rpm) || rpm <= 0) return; // unlimited
    const interval = 60_000 / rpm;
    const previous = this.chains.get(model) ?? Promise.resolve();
    const release = previous.then(() => this.pace(model, interval));
    // Drop the chain once settled so the next acquire starts fresh — pacing is
    // preserved by `nextAt`, which outlives the chain entry.
    const cleanup = (): void => {
      if (this.chains.get(model) === release) this.chains.delete(model);
    };
    release.then(cleanup, cleanup);
    this.chains.set(model, release);
    await release;
  }

  /** Sleep until `model`'s window opens, then advance it by one interval. */
  private async pace(model: string, interval: number): Promise<void> {
    const at = this.nextAt.get(model) ?? 0;
    const wait = Math.max(0, at - this.now());
    if (wait > 0) await this.sleep(wait);
    this.nextAt.set(model, Math.max(this.now(), at) + interval);
    const log = this.releases.get(model) ?? [];
    log.push(this.now());
    this.releases.set(model, log);
  }
}
