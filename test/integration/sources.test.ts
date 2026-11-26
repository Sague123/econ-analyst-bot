import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../../src/common/db.js";
import { PgHealth } from "../../src/common/health.js";
import { HttpClient } from "../../src/common/http.js";
import { Limiter, PgEventStore, QuotaExhaustedError } from "../../src/common/limiter.js";
import { migrate, readMigrations } from "../../src/common/migrate.js";
import { ALL_SOURCES, SOURCES } from "../../src/sources/registry.js";
import { FakeClock, silentLog, startServer } from "../helpers/fakes.js";

/** Лимитер и source_health на настоящем PostgreSQL. TEST_DATABASE_URL — подключение с правом CREATEDB. */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error("Задайте TEST_DATABASE_URL для интеграционных тестов");

const dbName = `analyst_test_${randomBytes(4).toString("hex")}`;
let admin: pg.Client;
let pool: Pool;
const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);

beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  pool = createPool({ DATABASE_URL: u.toString(), DB_POOL_MAX: 4 }, "analyst:test");
  await migrate(pool, await readMigrations(path.resolve("db/migrations")), { info: () => {} });
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${dbName} with (force)`);
  await admin?.end();
});

describe("дневной лимит BLS в базе", () => {
  it("счётчик переживает перезапуск: новый лимитер на той же базе отказывает после 500", async () => {
    const clock = new FakeClock(T0);
    const store = new PgEventStore(pool);
    const first = new Limiter("bls", SOURCES.bls.limits, { clock, persistent: store });
    for (let i = 0; i < 500; i++) await first.acquire();

    const { rows } = await pool.query("select count(*)::int as n from rate_events where key = 'bls:req'");
    expect(rows[0].n).toBe(500);

    // «Перезапуск»: новый лимитер, память пустая, база та же.
    const restarted = new Limiter("bls", SOURCES.bls.limits, { clock: new FakeClock(clock.t), persistent: new PgEventStore(pool) });
    const err = await restarted.acquire().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect((err as QuotaExhaustedError).retryAt.getTime()).toBe(T0 + 86_400_000);
  });

  it("события старше двух суток удаляются", async () => {
    const store = new PgEventStore(pool);
    await store.add("test:req", T0);
    await store.add("test:req", T0 + 3 * 86_400_000);
    const { rows } = await pool.query("select count(*)::int as n from rate_events where key = 'test:req'");
    expect(rows[0].n).toBe(1);
  });

  it("моменты событий читаются без потери точности", async () => {
    const store = new PgEventStore(pool);
    await store.add("precise:req", T0 + 123);
    expect(await store.list("precise:req", T0)).toEqual([T0 + 123]);
  });
});

describe("source_health", () => {
  it("регистрация заводит все источники; повторная — обновляет порог, а не дублирует", async () => {
    const health = new PgHealth(pool);
    await health.register(ALL_SOURCES);
    await health.register([{ ...SOURCES.fed, staleAfterMs: 60 * 60_000 }]);
    const { rows } = await pool.query(
      "select h.source_id, extract(epoch from h.stale_after)::int as secs from source_health h join sources s on s.id = h.source_id order by 1",
    );
    expect(rows.map((r) => r.source_id)).toEqual(ALL_SOURCES.map((s) => s.id).sort());
    expect(rows.find((r) => r.source_id === "fed")?.secs).toBe(3600);
  });

  it("клиент пишет удачу и ошибку в source_health", async () => {
    const health = new PgHealth(pool);
    await health.register(ALL_SOURCES);
    const server = await startServer((req, res) => (req.url === "/ok" ? res.writeHead(200).end("ok") : res.writeHead(404).end()));
    try {
      const clock = new FakeClock(T0);
      const limiter = new Limiter("sec", SOURCES.sec.limits, { clock });
      const http = new HttpClient({ sourceId: "sec", limiter, health, log: silentLog, userAgent: "test", clock });
      await http.get(`${server.url}/ok`);
      clock.advance(1000);
      await http.get(`${server.url}/missing`).catch(() => undefined);
      const { rows } = await pool.query("select last_ok_at, last_error_at, last_error from source_health where source_id = 'sec'");
      expect(rows[0].last_ok_at.getTime()).toBe(T0);
      expect(rows[0].last_error_at.getTime()).toBe(T0 + 1000);
      expect(rows[0].last_error).toMatch(/HTTP 404/);
    } finally {
      await server.close();
    }
  });
});
