import { loadConfig } from "./common/config.js";
import { createPool } from "./common/db.js";
import { createLogger } from "./common/logger.js";
import { migrate, readMigrations } from "./common/migrate.js";

/**
 * Точка входа всех процессов compose: `node dist/main.js <процесс>`.
 * collector, engine, api и bot пока только проверяют базу и ждут сигнала остановки:
 * их работа появляется в задачах этапов 1–3.
 */

const PROCESSES = ["migrate", "collector", "engine", "api", "bot"] as const;
type ProcessName = (typeof PROCESSES)[number];

const isProcess = (v: string | undefined): v is ProcessName => PROCESSES.includes(v as ProcessName);

async function runMigrate(): Promise<void> {
  const cfg = loadConfig(["core", "db", "migrate"]);
  const log = createLogger("migrate", cfg.core.LOG_LEVEL);
  const pool = createPool(cfg.db, "analyst:migrate", log);
  try {
    const files = await readMigrations(cfg.migrate.MIGRATIONS_DIR);
    await migrate(pool, files, log);
  } finally {
    await pool.end();
  }
}

async function runService(name: Exclude<ProcessName, "migrate">): Promise<void> {
  const cfg = loadConfig(["core", "db"]);
  const log = createLogger(name, cfg.core.LOG_LEVEL);
  const pool = createPool(cfg.db, `analyst:${name}`, log);
  await pool.query("select 1");
  log.info("процесс запущен, база доступна");

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGTERM", () => resolve("SIGTERM"));
    process.once("SIGINT", () => resolve("SIGINT"));
  });
  log.info({ signal }, "остановка");
  await pool.end();
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!isProcess(name)) {
    process.stderr.write(`Укажите процесс: ${PROCESSES.join(" | ")}\n`);
    process.exit(2);
  }
  if (name === "migrate") await runMigrate();
  else await runService(name);
}

main().catch((err: unknown) => {
  // Логгер мог не создаться (ошибка конфига), поэтому в stderr напрямую.
  process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
  process.exit(1);
});
