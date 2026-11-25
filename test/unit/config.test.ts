import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/common/config.js";

describe("loadConfig", () => {
  it("применяет значения по умолчанию", () => {
    const cfg = loadConfig(["core", "db", "migrate"], { DATABASE_URL: "postgres://u:p@h:5432/analyst" });
    expect(cfg.core).toEqual({ NODE_ENV: "development", LOG_LEVEL: "info" });
    expect(cfg.db.DB_POOL_MAX).toBe(5);
    expect(cfg.migrate.MIGRATIONS_DIR).toBe("db/migrations");
  });

  it("приводит числа из строк", () => {
    const cfg = loadConfig(["db"], { DATABASE_URL: "postgresql://h/analyst", DB_POOL_MAX: "12" });
    expect(cfg.db.DB_POOL_MAX).toBe(12);
  });

  it("проверяет только запрошенные разделы", () => {
    expect(() => loadConfig(["core"], {})).not.toThrow();
  });

  it("пустая переменная считается незаданной", () => {
    expect(() => loadConfig(["db"], { DATABASE_URL: "  " })).toThrow(/DATABASE_URL: не задана/);
    expect(loadConfig(["core"], { LOG_LEVEL: "" }).core.LOG_LEVEL).toBe("info");
  });

  it("перечисляет все ошибки сразу", () => {
    let err: unknown;
    try {
      loadConfig(["core", "db"], { LOG_LEVEL: "loud", DB_POOL_MAX: "0" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/LOG_LEVEL/);
    expect(msg).toMatch(/DATABASE_URL: не задана/);
    expect(msg).toMatch(/DB_POOL_MAX/);
  });

  it("не принимает чужую схему и не печатает значение в ошибке", () => {
    const secret = "https://user:s3cr3t-pass@example.com/db";
    let msg = "";
    try {
      loadConfig(["db"], { DATABASE_URL: secret });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/DATABASE_URL: ожидается строка подключения postgres/);
    expect(msg).not.toContain("s3cr3t-pass");
  });
});
