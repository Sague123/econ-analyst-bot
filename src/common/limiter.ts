import type { Pool } from "./db.js";

/**
 * Лимитер запросов к одному источнику: несколько скользящих окон сразу
 * (BLS — 50 за 10 с и 500 за сутки). Скользящее окно строже календарного:
 * если в любые 24 часа запросов не больше 500, то и в любые календарные сутки
 * источника, в каком бы поясе он их ни считал, тоже не больше 500.
 *
 * Короткое ожидание лимитер выдерживает сам. Если ждать дольше maxWaitMs,
 * он не держит запрос часами, а сразу бросает QuotaExhaustedError с моментом,
 * когда лимит освободится.
 */

export interface WindowSpec {
  limit: number;
  intervalMs: number;
  /** Хранить события в базе: окно длиннее жизни процесса (дневной лимит). */
  persist?: boolean;
}

export interface LimiterSpec {
  requests: readonly WindowSpec[];
  /** Окна по ошибочным ответам: у BEA не больше 30 ошибок в минуту. */
  errors?: readonly WindowSpec[];
}

export interface EventStore {
  /** Моменты событий по ключу начиная с sinceMs, по возрастанию. */
  list(key: string, sinceMs: number): Promise<number[]>;
  add(key: string, atMs: number): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class QuotaExhaustedError extends Error {
  override name = "QuotaExhaustedError";
  constructor(
    readonly sourceId: string,
    readonly retryAt: Date,
    reason: string,
  ) {
    super(`${sourceId}: ${reason} до ${retryAt.toISOString()}`);
  }
}

/** События в памяти процесса: для окон в секунды и минуты. */
export class MemoryEventStore implements EventStore {
  private events = new Map<string, number[]>();
  constructor(private readonly retentionMs = 2 * 86_400_000) {}

  async list(key: string, sinceMs: number): Promise<number[]> {
    return (this.events.get(key) ?? []).filter((t) => t >= sinceMs);
  }

  async add(key: string, atMs: number): Promise<void> {
    const list = (this.events.get(key) ?? []).filter((t) => t >= atMs - this.retentionMs);
    list.push(atMs);
    list.sort((a, b) => a - b);
    this.events.set(key, list);
  }
}

/** События в таблице rate_events: дневные окна переживают перезапуск процесса. */
export class PgEventStore implements EventStore {
  constructor(
    private readonly pool: Pool,
    private readonly retentionMs = 2 * 86_400_000,
  ) {}

  async list(key: string, sinceMs: number): Promise<number[]> {
    const { rows } = await this.pool.query<{ ms: string }>(
      `select (extract(epoch from at) * 1000)::bigint::text as ms
         from rate_events where key = $1 and at >= to_timestamp($2::double precision / 1000)
        order by at`,
      [key, sinceMs],
    );
    return rows.map((r) => Number(r.ms));
  }

  async add(key: string, atMs: number): Promise<void> {
    await this.pool.query("insert into rate_events (key, at) values ($1, to_timestamp($2::double precision / 1000))", [key, atMs]);
    await this.pool.query("delete from rate_events where key = $1 and at < to_timestamp($2::double precision / 1000)", [
      key,
      atMs - this.retentionMs,
    ]);
  }
}

export interface LimiterOptions {
  memory?: EventStore;
  /** Обязателен, если у источника есть окно с persist. */
  persistent?: EventStore;
  clock?: Clock;
  /** Дольше этого лимитер не ждёт, а отказывает. */
  maxWaitMs?: number;
}

export class Limiter {
  private readonly memory: EventStore;
  private readonly persistent: EventStore | undefined;
  private readonly clock: Clock;
  private readonly maxWaitMs: number;
  private blockedUntil = 0;
  private blockReason = "";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly sourceId: string,
    private readonly spec: LimiterSpec,
    opts: LimiterOptions = {},
  ) {
    const all = [...spec.requests, ...(spec.errors ?? [])];
    for (const w of all) {
      if (!(w.limit >= 1 && w.intervalMs > 0)) throw new Error(`${sourceId}: неверное окно лимита ${JSON.stringify(w)}`);
    }
    if (all.some((w) => w.persist) && !opts.persistent) {
      throw new Error(`${sourceId}: у источника есть дневное окно, нужно хранилище событий в базе`);
    }
    this.memory = opts.memory ?? new MemoryEventStore();
    this.persistent = opts.persistent;
    this.clock = opts.clock ?? systemClock;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
  }

  /** Дождаться права на один запрос и учесть его. Вызовы выстраиваются в очередь. */
  acquire(): Promise<void> {
    const run = this.queue.then(() => this.acquireNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Учесть ошибочный ответ: на него есть свои окна. */
  async recordError(): Promise<void> {
    await this.addEvent("err", this.spec.errors ?? [], this.clock.now());
  }

  /** Источник сам попросил подождать (Retry-After): до этого момента запросов нет. */
  blockUntil(atMs: number, reason: string): void {
    if (atMs > this.blockedUntil) {
      this.blockedUntil = atMs;
      this.blockReason = reason;
    }
  }

  private async acquireNow(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      let waitMs = 0;
      let reason = "";
      if (this.blockedUntil > now) {
        waitMs = this.blockedUntil - now;
        reason = this.blockReason;
      }
      for (const [kind, windows] of [["req", this.spec.requests], ["err", this.spec.errors ?? []]] as const) {
        for (const w of windows) {
          const events = await this.storeFor(w).list(this.key(kind), now - w.intervalMs + 1);
          if (events.length < w.limit) continue;
          // Окно освободится, когда из него выйдет событие, превышающее лимит.
          const freeAt = events[events.length - w.limit]! + w.intervalMs;
          if (freeAt - now > waitMs) {
            waitMs = freeAt - now;
            reason = `${kind === "req" ? "лимит запросов" : "лимит ошибок"} ${w.limit} за ${formatInterval(w.intervalMs)} исчерпан`;
          }
        }
      }
      if (waitMs <= 0) {
        await this.addEvent("req", this.spec.requests, now);
        return;
      }
      if (waitMs > this.maxWaitMs) throw new QuotaExhaustedError(this.sourceId, new Date(now + waitMs), reason);
      await this.clock.sleep(waitMs);
    }
  }

  private async addEvent(kind: "req" | "err", windows: readonly WindowSpec[], atMs: number): Promise<void> {
    if (windows.length === 0) return;
    if (windows.some((w) => !w.persist)) await this.memory.add(this.key(kind), atMs);
    if (windows.some((w) => w.persist)) await this.persistent!.add(this.key(kind), atMs);
  }

  private storeFor(w: WindowSpec): EventStore {
    return w.persist ? this.persistent! : this.memory;
  }

  private key(kind: "req" | "err"): string {
    return `${this.sourceId}:${kind}`;
  }
}

function formatInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} сут`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} ч`;
  if (ms % 60_000 === 0) return `${ms / 60_000} мин`;
  return `${ms / 1000} с`;
}
