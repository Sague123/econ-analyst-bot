import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "./db.js";

/**
 * Миграции — SQL-файлы вида NNN_имя.sql, применяются по порядку номеров.
 *
 * - Применённая миграция записывается в schema_migrations с контрольной суммой.
 *   Повторный запуск применяет только новые файлы.
 * - Изменённый или удалённый после применения файл — ошибка: исправление
 *   делается новой миграцией, а не правкой старой.
 * - Каждая миграция идёт в своей транзакции: упала — от неё ничего не осталось.
 * - Advisory lock не даёт двум запускам применить одно и то же одновременно.
 */

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

interface MigrateLog {
  info(obj: object, msg: string): void;
}

const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
/** Ключ advisory lock: одинаковый у всех запусков мигратора этой базы. */
const LOCK_KEY = 7_331_000_001n;

export const checksumOf = (sql: string) => createHash("sha256").update(sql).digest("hex");

export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const seen = new Map<string, string>();
  const out: MigrationFile[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) throw new MigrationError(`Имя миграции ${name} не по шаблону NNN_имя.sql`);
    const num = m[1]!;
    const other = seen.get(num);
    if (other) throw new MigrationError(`У миграций ${other} и ${name} один номер ${num}`);
    seen.set(num, name);
    const sql = await readFile(path.join(dir, name), "utf8");
    out.push({ name, sql, checksum: checksumOf(sql) });
  }
  return out;
}

/** Какие файлы применить. Бросает ошибку, если история в базе расходится с файлами. */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationFile[] {
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const a of applied) {
    const f = byName.get(a.name);
    if (!f) throw new MigrationError(`Миграция ${a.name} применена, но файла нет`);
    if (f.checksum !== a.checksum) {
      throw new MigrationError(`Миграция ${a.name} изменена после применения: исправления — новой миграцией`);
    }
  }
  const done = new Set(applied.map((a) => a.name));
  const pending = files.filter((f) => !done.has(f.name));
  const lastApplied = applied.map((a) => a.name).sort().at(-1);
  const early = lastApplied ? pending.find((f) => f.name < lastApplied) : undefined;
  if (early) throw new MigrationError(`Миграция ${early.name} старше уже применённой ${lastApplied}`);
  return pending;
}

export async function migrate(pool: Pool, files: MigrationFile[], log: MigrateLog): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY.toString()]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          name       text primary key,
          checksum   text not null,
          applied_at timestamptz not null default now()
        )`);
      const { rows } = await client.query<AppliedMigration>("select name, checksum from schema_migrations order by name");
      const pending = planMigrations(files, rows);
      for (const f of pending) {
        await client.query("begin");
        try {
          await client.query(f.sql);
          await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [f.name, f.checksum]);
          await client.query("commit");
        } catch (err) {
          await client.query("rollback");
          throw new MigrationError(`Миграция ${f.name} не применилась: ${(err as Error).message}`, { cause: err });
        }
        log.info({ migration: f.name }, "миграция применена");
      }
      log.info({ applied: pending.length, total: files.length }, pending.length ? "миграции применены" : "новых миграций нет");
      return { applied: pending.map((f) => f.name) };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}
