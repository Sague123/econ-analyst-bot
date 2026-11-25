import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumOf, MigrationError, planMigrations, readMigrations, type MigrationFile } from "../../src/common/migrate.js";

const file = (name: string, sql = `-- ${name}`): MigrationFile => ({ name, sql, checksum: checksumOf(sql) });

describe("readMigrations", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("читает .sql по порядку номеров и пропускает прочие файлы", async () => {
    await writeFile(path.join(dir, "002_news.sql"), "select 2;");
    await writeFile(path.join(dir, "001_core.sql"), "select 1;");
    await writeFile(path.join(dir, "README.md"), "не миграция");
    const files = await readMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["001_core.sql", "002_news.sql"]);
    expect(files[0]!.checksum).toBe(checksumOf("select 1;"));
  });

  it("отклоняет имя не по шаблону", async () => {
    await writeFile(path.join(dir, "1_core.sql"), "select 1;");
    await expect(readMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it("отклоняет два файла с одним номером", async () => {
    await writeFile(path.join(dir, "003_a.sql"), "select 1;");
    await writeFile(path.join(dir, "003_b.sql"), "select 2;");
    await expect(readMigrations(dir)).rejects.toThrow(/один номер 003/);
  });
});

describe("planMigrations", () => {
  const files = [file("001_core.sql"), file("002_news.sql"), file("003_insight.sql")];

  it("на пустой базе применяет всё", () => {
    expect(planMigrations(files, []).map((f) => f.name)).toEqual(["001_core.sql", "002_news.sql", "003_insight.sql"]);
  });

  it("повторно ничего не применяет", () => {
    const applied = files.map(({ name, checksum }) => ({ name, checksum }));
    expect(planMigrations(files, applied)).toEqual([]);
  });

  it("применяет только новые", () => {
    const applied = files.slice(0, 2).map(({ name, checksum }) => ({ name, checksum }));
    expect(planMigrations(files, applied).map((f) => f.name)).toEqual(["003_insight.sql"]);
  });

  it("падает, если применённый файл изменили", () => {
    const applied = [{ name: "001_core.sql", checksum: checksumOf("старый текст") }];
    expect(() => planMigrations(files, applied)).toThrow(/изменена после применения/);
  });

  it("падает, если применённый файл удалили", () => {
    const applied = [{ name: "000_gone.sql", checksum: "x" }];
    expect(() => planMigrations(files, applied)).toThrow(/файла нет/);
  });

  it("падает, если новый файл старше применённого", () => {
    const applied = [files[0]!, files[2]!].map(({ name, checksum }) => ({ name, checksum }));
    expect(() => planMigrations(files, applied)).toThrow(/старше уже применённой/);
  });
});
