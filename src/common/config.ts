import { z } from "zod";

/**
 * Конфиг из переменных окружения, по разделам. Каждый процесс проверяет только
 * те разделы, которые использует: боту не нужен ключ BLS, сборщику — токен бота.
 * Новые разделы добавляются в задачах, где появляется их потребитель.
 */

const postgresUrl = z
  .string()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "postgres:" || u.protocol === "postgresql:";
    } catch {
      return false;
    }
  }, "ожидается строка подключения postgres://…");

const schemas = {
  core: z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  }),
  db: z.object({
    DATABASE_URL: postgresUrl,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  }),
  migrate: z.object({
    MIGRATIONS_DIR: z.string().min(1).default("db/migrations"),
  }),
} as const;

type Schemas = typeof schemas;
export type Section = keyof Schemas;
export type Config<S extends Section> = { [K in S]: z.infer<Schemas[K]> };

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Пустая переменная — то же, что отсутствующая: срабатывают значения по умолчанию и проверка обязательных. */
function withoutEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== "") out[k] = v;
  return out;
}

/**
 * Читает и проверяет разделы конфига. Ошибка перечисляет все проблемные
 * переменные сразу и никогда не содержит их значений: там бывают секреты.
 */
export function loadConfig<S extends Section>(sections: readonly S[], env: NodeJS.ProcessEnv = process.env): Config<S> {
  const clean = withoutEmpty(env);
  const out: Partial<Record<Section, unknown>> = {};
  const problems: string[] = [];
  for (const s of sections) {
    const r = schemas[s].safeParse(clean);
    if (r.success) {
      out[s] = r.data;
      continue;
    }
    for (const issue of r.error.issues) {
      const name = issue.path.join(".");
      const reason = issue.code === "invalid_type" && !(name in clean) ? "не задана" : issue.message;
      problems.push(`${name}: ${reason}`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Неверная конфигурация:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return out as Config<S>;
}
