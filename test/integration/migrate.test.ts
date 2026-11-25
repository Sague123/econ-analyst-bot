import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../../src/common/db.js";
import { migrate, readMigrations } from "../../src/common/migrate.js";

/**
 * Миграции на настоящем PostgreSQL 16. TEST_DATABASE_URL — подключение с правом
 * CREATEDB: тест создаёт свою чистую базу и удаляет её в конце.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error("Задайте TEST_DATABASE_URL для интеграционных тестов");

const MIGRATIONS = path.resolve("db/migrations");
const silent = { info: () => {} };
const dbName = `analyst_test_${randomBytes(4).toString("hex")}`;
let admin: pg.Client;
let pool: Pool;

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/** Всё, что описывает схему: колонки, ограничения, индексы, типы. */
async function schemaSnapshot(p: Pool): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await p.query(sql)).rows);
  return [
    await q(`select table_name, column_name, data_type, is_nullable, column_default
             from information_schema.columns where table_schema = 'public' order by 1, 2`),
    await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def
             from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`),
    await q(`select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid order by 1, e.enumsortorder`),
  ].join("\n");
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  pool = createPool({ DATABASE_URL: withDb(adminUrl, dbName), DB_POOL_MAX: 4 }, "analyst:test");
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`drop database if exists ${dbName} with (force)`);
  await admin?.end();
});

describe("миграции на чистой базе", () => {
  it("первый запуск применяет 001–004", async () => {
    const files = await readMigrations(MIGRATIONS);
    const r = await migrate(pool, files, silent);
    expect(r.applied).toEqual(["001_core.sql", "002_news.sql", "003_insight.sql", "004_users.sql"]);
  });

  it("повторный запуск ничего не применяет и не меняет схему", async () => {
    const before = await schemaSnapshot(pool);
    const r = await migrate(pool, await readMigrations(MIGRATIONS), silent);
    expect(r.applied).toEqual([]);
    expect(await schemaSnapshot(pool)).toBe(before);
  });

  it("два одновременных запуска не мешают друг другу", async () => {
    const files = await readMigrations(MIGRATIONS);
    const [a, b] = await Promise.all([migrate(pool, files, silent), migrate(pool, files, silent)]);
    expect([...a.applied, ...b.applied]).toEqual([]);
  });

  it("изменённая после применения миграция останавливает запуск", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
    try {
      await cp(MIGRATIONS, dir, { recursive: true });
      await appendFile(path.join(dir, "002_news.sql"), "\n-- правка задним числом\n");
      await expect(migrate(pool, await readMigrations(dir), silent)).rejects.toThrow(/002_news\.sql изменена/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("упавшая миграция откатывается целиком", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
    try {
      await cp(MIGRATIONS, dir, { recursive: true });
      await appendFile(path.join(dir, "005_broken.sql"), "create table half_done (id int);\nselect * from no_such_table;\n");
      await expect(migrate(pool, await readMigrations(dir), silent)).rejects.toThrow(/005_broken\.sql не применилась/);
      const { rows } = await pool.query("select to_regclass('public.half_done') as t");
      expect(rows[0].t).toBeNull();
      const applied = await pool.query("select count(*)::int as n from schema_migrations");
      expect(applied.rows[0].n).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("схема", () => {
  it("сессия работает в UTC", async () => {
    const { rows } = await pool.query("show timezone");
    expect(rows[0].TimeZone).toBe("UTC");
  });

  it("факт без ref_period не дублируется", async () => {
    await pool.query("insert into sources (id, name) values ('flowscope', 'Flowscope') on conflict do nothing");
    const insert = `insert into facts (fact_key, metric, kind, unit, period, value, source_id, published_at)
                    values ('BTCUSDT.OI.CHG_4H', 'open_interest', 'change', '%', '4h', 1.5, 'flowscope', now())`;
    await pool.query(insert);
    await expect(pool.query(insert)).rejects.toThrow(/facts_key_period_revision_key/);
  });

  it("пересмотр — новая строка, первое значение остаётся", async () => {
    await pool.query("insert into sources (id, name) values ('bls', 'BLS') on conflict do nothing");
    const insert = (rev: number, value: number) =>
      pool.query(
        `insert into facts (fact_key, metric, kind, unit, period, ref_period, value, source_id, published_at, revision)
         values ('US.CPI.YOY', 'cpi', 'rate', '%', 'y/y', '2026-10-01', $1, 'bls', now(), $2)`,
        [value, rev],
      );
    await insert(0, 3.1);
    await insert(1, 3.2);
    const { rows } = await pool.query("select revision, value from facts where fact_key = 'US.CPI.YOY' order by revision");
    expect(rows).toEqual([
      { revision: 0, value: "3.1" },
      { revision: 1, value: "3.2" },
    ]);
  });

  it("удаление пользователя убирает его правила и журнал отправок", async () => {
    await pool.query("insert into users (tg_user_id) values (42)");
    await pool.query("insert into alert_rules (tg_user_id, kind) values (42, 'insight')");
    await pool.query("insert into alerts_sent (dedupe_key, tg_user_id) values ('42:insight:1', 42), ('channel:insight:1', null)");
    await pool.query("delete from users where tg_user_id = 42");
    const left = await pool.query("select dedupe_key from alerts_sent order by 1");
    expect(left.rows).toEqual([{ dedupe_key: "channel:insight:1" }]);
    const rules = await pool.query("select count(*)::int as n from alert_rules");
    expect(rules.rows[0].n).toBe(0);
  });

  it("карточка без движения и без релиза не записывается", async () => {
    await expect(
      pool.query("insert into insights (fact_ids, candidates, rendered) values ('{}', '[]', '{}')"),
    ).rejects.toThrow(/insights_check/);
  });
});
