import type { HealthRecorder } from "./health.js";
import { QuotaExhaustedError, systemClock, type Clock, type Limiter } from "./limiter.js";
import type { Logger } from "./logger.js";

/**
 * HTTP-клиент одного внешнего источника. Каждый запрос:
 * 1. ждёт лимитер источника (каждая попытка — запрос в счёт лимита);
 * 2. идёт с таймаутом;
 * 3. при сетевой ошибке, таймауте, 429 и 5xx повторяется с растущей паузой;
 *    Retry-After источника важнее своей паузы;
 * 4. итог пишется в source_health: удача — last_ok_at, провал — last_error.
 *
 * Retry-After длиннее maxRetryAfterMs (BEA блокирует на час) запрос не держит:
 * источник блокируется до этого момента, а вызов сразу получает ошибку.
 */

export type RequestErrorKind = "status" | "network" | "timeout" | "quota" | "rate_limited" | "too_large";

export class SourceRequestError extends Error {
  override name = "SourceRequestError";
  constructor(
    readonly sourceId: string,
    readonly kind: RequestErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAt?: Date,
    options?: { cause?: unknown },
  ) {
    super(`${sourceId}: ${message}`, options);
  }
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Headers;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Объект уходит как JSON. */
  json?: unknown;
}

export interface HttpClientOptions {
  sourceId: string;
  limiter: Limiter;
  health: HealthRecorder;
  log: Logger;
  userAgent: string;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  timeoutMs?: number;
  /** Сколько раз повторить после первой попытки. */
  retries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxRetryAfterMs?: number;
  maxBodyBytes?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const SECRET_PARAM = /key|userid|token|secret|password|sig/i;

/** URL для логов и ошибок: значения параметров-ключей заменены. BEA, например, берёт UserID в строке запроса. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const name of [...u.searchParams.keys()]) if (SECRET_PARAM.test(name)) u.searchParams.set(name, "***");
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "[неразборчивый URL]";
  }
}

/** Retry-After: секунды или HTTP-дата. Возвращает паузу в мс или null, если заголовка нет или он неразборчив. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxBodyBytes: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 20 * 1024 * 1024;
  }

  get(url: string, options: Omit<RequestOptions, "method" | "json"> = {}): Promise<HttpResponse> {
    return this.request(url, { ...options, method: "GET" });
  }

  post(url: string, json: unknown, options: Omit<RequestOptions, "method" | "json"> = {}): Promise<HttpResponse> {
    return this.request(url, { ...options, method: "POST", json });
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    try {
      const res = await this.withRetries(url, options);
      await this.recordHealth("ok", "");
      return res;
    } catch (err) {
      const e = this.toRequestError(err);
      await this.recordHealth("error", e.message);
      throw e;
    }
  }

  private async withRetries(url: string, options: RequestOptions): Promise<HttpResponse> {
    const { sourceId, limiter, log } = this.opts;
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      const outcome = await this.attempt(url, options);
      if ("res" in outcome) return outcome.res;
      const { failure, retryable, retryAfterMs } = outcome;
      if (!retryable) throw failure;

      if (retryAfterMs !== null && retryAfterMs > this.maxRetryAfterMs) {
        const retryAt = new Date(this.clock.now() + retryAfterMs);
        limiter.blockUntil(retryAt.getTime(), `источник попросил паузу (Retry-After) после HTTP ${failure.status}`);
        throw new SourceRequestError(sourceId, "rate_limited", `${failure.message}, Retry-After до ${retryAt.toISOString()}`, failure.status, retryAt);
      }
      if (attempt >= this.retries) throw failure;

      const delayMs = retryAfterMs ?? this.backoffDelay(attempt);
      log.warn({ source: sourceId, attempt: attempt + 1, delayMs, error: failure.message }, "повтор запроса");
      await this.clock.sleep(delayMs);
    }
  }

  /** Одна попытка: ответ или разобранный провал. Ошибочные ответы и обрывы учитываются в окнах ошибок лимитера. */
  private async attempt(
    url: string,
    options: RequestOptions,
  ): Promise<{ res: HttpResponse } | { failure: SourceRequestError; retryable: boolean; retryAfterMs: number | null }> {
    const { sourceId, limiter } = this.opts;
    const safeUrl = redactUrl(url);
    let res: HttpResponse;
    try {
      res = await this.once(url, options);
    } catch (err) {
      if (err instanceof SourceRequestError) return { failure: err, retryable: false, retryAfterMs: null };
      await limiter.recordError();
      const timeout = isTimeout(err);
      const message = timeout ? `нет ответа за ${this.timeoutMs} мс на ${safeUrl}` : `сеть: ${(err as Error).message} на ${safeUrl}`;
      return {
        failure: new SourceRequestError(sourceId, timeout ? "timeout" : "network", message, undefined, undefined, { cause: err }),
        retryable: true,
        retryAfterMs: null,
      };
    }
    if ((res.status >= 200 && res.status < 300) || res.status === 304) return { res };
    await limiter.recordError();
    return {
      failure: new SourceRequestError(sourceId, "status", `HTTP ${res.status} на ${safeUrl}`, res.status),
      retryable: RETRYABLE_STATUS.has(res.status),
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), this.clock.now()),
    };
  }

  /** Растущая пауза с разбросом: половина — фиксированная, половина — случайная. */
  private backoffDelay(attempt: number): number {
    const cap = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt);
    return Math.round(cap / 2 + (cap / 2) * this.random());
  }

  private async once(url: string, options: RequestOptions): Promise<HttpResponse> {
    const headers: Record<string, string> = { "user-agent": this.opts.userAgent, ...options.headers };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["content-type"] = "application/json";
    }
    const res = await this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const buf = await this.readBody(res, url);
    return {
      status: res.status,
      url: res.url || url,
      headers: res.headers,
      body: buf,
      text: () => buf.toString("utf8"),
      json: <T>() => JSON.parse(buf.toString("utf8")) as T,
    };
  }

  /** Тело с ограничением размера: источник не должен уметь занять всю память процесса. */
  private async readBody(res: Response, url: string): Promise<Buffer> {
    const tooLarge = () =>
      new SourceRequestError(this.opts.sourceId, "too_large", `ответ больше ${this.maxBodyBytes} байт на ${redactUrl(url)}`, res.status);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > this.maxBodyBytes) {
        await res.body.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private toRequestError(err: unknown): SourceRequestError {
    if (err instanceof SourceRequestError) return err;
    if (err instanceof QuotaExhaustedError) {
      return new SourceRequestError(this.opts.sourceId, "quota", err.message.replace(`${this.opts.sourceId}: `, ""), undefined, err.retryAt, {
        cause: err,
      });
    }
    return new SourceRequestError(this.opts.sourceId, "network", (err as Error)?.message ?? String(err), undefined, undefined, { cause: err });
  }

  /** source_health не должен ронять запрос: сбой записи только в лог. */
  private async recordHealth(kind: "ok" | "error", message: string): Promise<void> {
    const at = new Date(this.clock.now());
    try {
      if (kind === "ok") await this.opts.health.ok(this.opts.sourceId, at);
      else await this.opts.health.error(this.opts.sourceId, message, at);
    } catch (err) {
      this.opts.log.warn({ source: this.opts.sourceId, err }, "не удалось записать source_health");
    }
  }
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string } };
  return e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";
}
