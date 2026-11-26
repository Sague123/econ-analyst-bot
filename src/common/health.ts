import type { Pool } from "./db.js";

/**
 * Состояние источников в source_health: когда был последний удачный ответ,
 * когда и с чем — последняя ошибка, через сколько данные считаются устаревшими.
 * По нему Обзор и монитор свежести пишут «задержка» и «нет данных».
 */

export interface HealthRecorder {
  ok(sourceId: string, at: Date): Promise<void>;
  error(sourceId: string, message: string, at: Date): Promise<void>;
}

export interface SourceRegistration {
  id: string;
  name: string;
  termsNote: string;
  staleAfterMs: number;
}

const MAX_ERROR_LEN = 500;

export class PgHealth implements HealthRecorder {
  constructor(private readonly pool: Pool) {}

  /** Завести источник: строка в sources и в source_health. Повторный вызов обновляет описание и порог. */
  async register(defs: readonly SourceRegistration[]): Promise<void> {
    for (const d of defs) {
      await this.pool.query(
        `insert into sources (id, name, terms_note) values ($1, $2, $3)
         on conflict (id) do update set name = excluded.name, terms_note = excluded.terms_note`,
        [d.id, d.name, d.termsNote],
      );
      await this.pool.query(
        `insert into source_health (source_id, stale_after) values ($1, make_interval(secs => $2))
         on conflict (source_id) do update set stale_after = excluded.stale_after`,
        [d.id, d.staleAfterMs / 1000],
      );
    }
  }

  async ok(sourceId: string, at: Date): Promise<void> {
    await this.pool.query("update source_health set last_ok_at = greatest(last_ok_at, $2) where source_id = $1", [sourceId, at]);
  }

  async error(sourceId: string, message: string, at: Date): Promise<void> {
    await this.pool.query("update source_health set last_error_at = $2, last_error = $3 where source_id = $1", [
      sourceId,
      at,
      message.slice(0, MAX_ERROR_LEN),
    ]);
  }
}
