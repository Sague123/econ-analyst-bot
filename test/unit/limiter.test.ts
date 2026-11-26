import { describe, expect, it } from "vitest";
import { Limiter, MemoryEventStore, QuotaExhaustedError } from "../../src/common/limiter.js";
import { SOURCES } from "../../src/sources/registry.js";
import { FakeClock } from "../helpers/fakes.js";

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);

describe("Limiter: короткие окна", () => {
  it("51-й запрос к BLS за 10 секунд ждёт, пока выйдет первый", async () => {
    const clock = new FakeClock(T0);
    const lim = new Limiter("bls", { requests: [{ limit: 50, intervalMs: 10_000 }] }, { clock });
    for (let i = 0; i < 50; i++) await lim.acquire();
    expect(clock.sleeps).toEqual([]);
    await lim.acquire();
    expect(clock.sleeps).toEqual([10_000]);
    expect(clock.t).toBe(T0 + 10_000);
  });

  it("параллельные вызовы не проскакивают лимит", async () => {
    const clock = new FakeClock(T0);
    const lim = new Limiter("sec", { requests: [{ limit: 10, intervalMs: 1000 }] }, { clock });
    const grantedAt: number[] = [];
    await Promise.all(Array.from({ length: 25 }, () => lim.acquire().then(() => grantedAt.push(clock.t))));
    expect(grantedAt.filter((t) => t === T0)).toHaveLength(10);
    expect(grantedAt.filter((t) => t === T0 + 1000)).toHaveLength(10);
    expect(grantedAt.filter((t) => t === T0 + 2000)).toHaveLength(5);
  });

  it("окно ошибок BEA: после 30 ошибок за минуту следующий запрос ждёт", async () => {
    const clock = new FakeClock(T0);
    const lim = new Limiter("bea", SOURCES.bea.limits, { clock });
    for (let i = 0; i < 30; i++) {
      await lim.acquire();
      await lim.recordError();
      clock.advance(100);
    }
    const before = clock.t;
    await lim.acquire();
    expect(clock.t).toBe(T0 + 60_000);
    expect(clock.t - before).toBe(60_000 - 3000);
  });

  it("блокировка по Retry-After: дольше maxWaitMs — отказ с моментом снятия", async () => {
    const clock = new FakeClock(T0);
    const lim = new Limiter("bea", SOURCES.bea.limits, { clock });
    lim.blockUntil(T0 + 3_600_000, "Retry-After");
    const err = await lim.acquire().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect((err as QuotaExhaustedError).retryAt.getTime()).toBe(T0 + 3_600_000);
    clock.advance(3_600_000);
    await expect(lim.acquire()).resolves.toBeUndefined();
  });

  it("неверное окно и дневное окно без хранилища — ошибка конструктора", () => {
    expect(() => new Limiter("x", { requests: [{ limit: 0, intervalMs: 1000 }] })).toThrow(/неверное окно/);
    expect(() => new Limiter("bls", SOURCES.bls.limits)).toThrow(/хранилище событий в базе/);
  });
});

describe("Limiter: дневной лимит BLS", () => {
  const blsLimiter = (clock: FakeClock, persistent = new MemoryEventStore()) =>
    new Limiter("bls", SOURCES.bls.limits, { clock, persistent });

  it("500 запросов проходят, 501-й получает отказ до освобождения окна", async () => {
    const clock = new FakeClock(T0);
    const lim = blsLimiter(clock);
    for (let i = 0; i < 500; i++) await lim.acquire();
    // По пути лимитер выдерживал окно 50 за 10 с: 9 пауз по 10 с.
    expect(clock.sleeps).toEqual(Array(9).fill(10_000));
    const err = await lim.acquire().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    // Первый запрос был в T0: окно освободится ровно через сутки после него.
    expect((err as QuotaExhaustedError).retryAt.getTime()).toBe(T0 + 86_400_000);
    expect((err as Error).message).toMatch(/лимит запросов 500 за 1 сут исчерпан/);
  });

  it("после выхода первых запросов из окна снова можно", async () => {
    const clock = new FakeClock(T0);
    const lim = blsLimiter(clock);
    for (let i = 0; i < 500; i++) await lim.acquire();
    clock.t = T0 + 86_400_000;
    await expect(lim.acquire()).resolves.toBeUndefined();
  });

  it("перезапуск процесса не обнуляет счётчик: новый лимитер видит те же события", async () => {
    const clock = new FakeClock(T0);
    const store = new MemoryEventStore();
    const first = blsLimiter(clock, store);
    for (let i = 0; i < 500; i++) await first.acquire();
    const afterRestart = blsLimiter(clock, store);
    await expect(afterRestart.acquire()).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});
