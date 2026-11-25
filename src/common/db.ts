import pg from "pg";
import type { Logger } from "./logger.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface DbConfig {
  DATABASE_URL: string;
  DB_POOL_MAX: number;
}

/**
 * Пул к базе analyst. Сессия всегда в UTC, что бы ни стояло на сервере:
 * время в базе и коде — UTC, Прага появляется только при показе.
 */
export function createPool(cfg: DbConfig, applicationName: string, log?: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DB_POOL_MAX,
    application_name: applicationName,
    options: "-c timezone=UTC",
  });
  // Оборванное простаивающее соединение не должно ронять процесс.
  pool.on("error", (err) => log?.error({ err }, "ошибка простаивающего соединения с базой"));
  return pool;
}
