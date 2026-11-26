import { afterEach, describe, expect, it } from "vitest";
import { HttpClient, parseRetryAfter, redactUrl, SourceRequestError } from "../../src/common/http.js";
import { Limiter, MemoryEventStore, type LimiterSpec } from "../../src/common/limiter.js";
import { SOURCES } from "../../src/sources/registry.js";
import { FakeClock, MemoryHealth, silentLog, startServer } from "../helpers/fakes.js";

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(sourceId: string, limits: LimiterSpec, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const clock = new FakeClock(T0);
  const health = new MemoryHealth();
  const limiter = new Limiter(sourceId, limits, { clock, persistent: new MemoryEventStore() });
  const http = new HttpClient({ sourceId, limiter, health, log: silentLog, userAgent: "econ-analyst-bot/test", clock, random: () => 0.5, ...extra });
  return { http, clock, health, limiter };
}

describe("429 и Retry-After", () => {
  it("ждёт столько, сколько сказал Retry-After в секундах, и повторяет", async () => {
    server = await startServer((_req, res, n) => {
      if (n === 1) res.writeHead(429, { "retry-after": "7" }).end("slow down");
      else res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    const { http, clock, health } = client("bea", SOURCES.bea.limits);
    const res = await http.get(`${server.url}/data`);
    expect(res.json()).toEqual({ ok: true });
    expect(server.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([7000]);
    expect(health.last()).toMatchObject({ kind: "ok", sourceId: "bea" });
  });

  it("понимает Retry-After в виде HTTP-даты", async () => {
    const retryAt = new Date(T0 + 12_000).toUTCString();
    server = await startServer((_req, res, n) => {
      if (n === 1) res.writeHead(429, { "retry-after": retryAt }).end();
      else res.writeHead(200).end("ok");
    });
    const { http, clock } = client("bea", SOURCES.bea.limits);
    await http.get(server.url);
    expect(clock.sleeps).toEqual([12_000]);
  });

  it("долгий Retry-After не держит запрос: источник блокируется, следующий вызов не идёт в сеть", async () => {
    server = await startServer((_req, res) => res.writeHead(429, { "retry-after": "3600" }).end());
    const { http, clock, health } = client("bea", SOURCES.bea.limits);
    const err = (await http.get(`${server.url}/?UserID=SECRET-ID&method=GetData`).catch((e: unknown) => e)) as SourceRequestError;
    expect(err).toBeInstanceOf(SourceRequestError);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAt?.getTime()).toBe(T0 + 3_600_000);
    expect(err.message).not.toContain("SECRET-ID");
    expect(clock.sleeps).toEqual([]);
    expect(health.last()).toMatchObject({ kind: "error", sourceId: "bea" });
    expect(health.last()?.message).not.toContain("SECRET-ID");

    const again = (await http.get(server.url).catch((e: unknown) => e)) as SourceRequestError;
    expect(again.kind).toBe("quota");
    expect(server.requests).toHaveLength(1);
  });

  it("429 без Retry-After — растущая пауза, после исчерпания повторов ошибка", async () => {
    server = await startServer((_req, res) => res.writeHead(429).end());
    const { http, clock, health } = client("bea", SOURCES.bea.limits, { retries: 3 });
    const err = (await http.get(server.url).catch((e: unknown) => e)) as SourceRequestError;
    expect(err.kind).toBe("status");
    expect(err.status).toBe(429);
    expect(server.requests).toHaveLength(4);
    // база 500 мс, удвоение, разброс фиксирован: random = 0.5 → 75% от потолка
    expect(clock.sleeps).toEqual([375, 750, 1500]);
    expect(health.last()?.kind).toBe("error");
  });
});

describe("дневной лимит BLS", () => {
  it("после 500 запросов за сутки клиент отказывает, не обращаясь к BLS, и пишет source_health", async () => {
    server = await startServer((_req, res) => res.writeHead(200).end('{"status":"REQUEST_SUCCEEDED"}'));
    const { http, health } = client("bls", SOURCES.bls.limits);
    for (let i = 0; i < 500; i++) await http.post(`${server.url}/publicAPI/v2/timeseries/data/`, { seriesid: ["CUUR0000SA0"] });
    expect(server.requests).toHaveLength(500);

    const err = (await http.post(`${server.url}/publicAPI/v2/timeseries/data/`, {}).catch((e: unknown) => e)) as SourceRequestError;
    expect(err).toBeInstanceOf(SourceRequestError);
    expect(err.kind).toBe("quota");
    expect(err.retryAt?.getTime()).toBe(T0 + 86_400_000);
    expect(server.requests).toHaveLength(500);
    expect(health.last()).toMatchObject({ kind: "error", sourceId: "bls" });
    expect(health.last()?.message).toMatch(/лимит запросов 500 за 1 сут исчерпан до 2026-11-27T12:00:00.000Z/);
  });

  it("повторы тоже идут в счёт лимита", async () => {
    server = await startServer((_req, res, n) => (n % 2 === 1 ? res.writeHead(503).end() : res.writeHead(200).end("{}")));
    const { http } = client("bls", { requests: [{ limit: 4, intervalMs: 86_400_000, persist: true }] });
    await http.get(server.url); // 503, затем 200: два запроса
    await http.get(server.url); // ещё два
    const err = (await http.get(server.url).catch((e: unknown) => e)) as SourceRequestError;
    expect(err.kind).toBe("quota");
    expect(server.requests).toHaveLength(4);
  });
});

describe("прочие ответы", () => {
  it("404 не повторяется", async () => {
    server = await startServer((_req, res) => res.writeHead(404).end());
    const { http, clock } = client("fed", SOURCES.fed.limits);
    const err = (await http.get(server.url).catch((e: unknown) => e)) as SourceRequestError;
    expect(err.kind).toBe("status");
    expect(err.status).toBe(404);
    expect(server.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("304 — удачный ответ для условного GET", async () => {
    server = await startServer((_req, res) => res.writeHead(304, { etag: '"abc"' }).end());
    const { http, health } = client("fed", SOURCES.fed.limits);
    const res = await http.get(server.url, { headers: { "if-none-match": '"abc"' } });
    expect(res.status).toBe(304);
    expect(server.requests[0]?.headers["if-none-match"]).toBe('"abc"');
    expect(health.last()?.kind).toBe("ok");
  });

  it("таймаут повторяется и даёт ошибку timeout", async () => {
    server = await startServer(() => {
      /* не отвечает */
    });
    const { http } = client("sec", SOURCES.sec.limits, { timeoutMs: 50, retries: 1 });
    const err = (await http.get(server.url).catch((e: unknown) => e)) as SourceRequestError;
    expect(err.kind).toBe("timeout");
    expect(server.requests).toHaveLength(2);
  });

  it("сетевая ошибка повторяется и даёт ошибку network", async () => {
    const { http } = client("sec", SOURCES.sec.limits, { retries: 2 });
    const err = (await http.get("http://127.0.0.1:1/").catch((e: unknown) => e)) as SourceRequestError;
    expect(err.kind).toBe("network");
  });

  it("слишком большой ответ обрывается", async () => {
    server = await startServer((_req, res) => res.writeHead(200).end("x".repeat(5000)));
    const { http } = client("fed", SOURCES.fed.limits, { maxBodyBytes: 1000 });
    const err = (await http.get(server.url).catch((e: unknown) => e)) as SourceRequestError;
    expect(err.kind).toBe("too_large");
    expect(server.requests).toHaveLength(1);
  });

  it("шлёт User-Agent источника и JSON в POST", async () => {
    server = await startServer((_req, res) => res.writeHead(200).end("{}"));
    const { http } = client("sec", SOURCES.sec.limits, { userAgent: "Example Co admin@example.com" });
    await http.post(server.url, { a: 1 });
    expect(server.requests[0]).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(server.requests[0]?.headers["user-agent"]).toBe("Example Co admin@example.com");
    expect(server.requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("сбой записи source_health не роняет запрос", async () => {
    server = await startServer((_req, res) => res.writeHead(200).end("ok"));
    const broken = { ok: () => Promise.reject(new Error("db down")), error: () => Promise.reject(new Error("db down")) };
    const { http } = client("fed", SOURCES.fed.limits, { health: broken });
    await expect(http.get(server.url)).resolves.toMatchObject({ status: 200 });
  });
});

describe("разбор и маскировка", () => {
  it("parseRetryAfter", () => {
    expect(parseRetryAfter("120", T0)).toBe(120_000);
    expect(parseRetryAfter(new Date(T0 + 5000).toUTCString(), T0)).toBe(5000);
    expect(parseRetryAfter(new Date(T0 - 5000).toUTCString(), T0)).toBe(0);
    expect(parseRetryAfter(null, T0)).toBeNull();
    expect(parseRetryAfter("скоро", T0)).toBeNull();
  });

  it("redactUrl скрывает ключи в строке запроса и пароль", () => {
    const out = redactUrl("https://u:pw@apps.bea.gov/api/data?UserID=ABC-123&method=GetData&registrationkey=k1");
    expect(out).not.toMatch(/ABC-123|k1|pw/);
    expect(out).toContain("method=GetData");
  });
});
