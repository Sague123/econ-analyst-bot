import { pino, type Logger, type LevelWithSilent } from "pino";

export type { Logger };

/** JSON-логи в stdout; время — ISO в UTC. Поля с секретами вырезаются на всякий случай. */
export function createLogger(proc: string, level: LevelWithSilent = "info"): Logger {
  return pino({
    level,
    base: { proc },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["password", "*.password", "token", "*.token", "apiKey", "*.apiKey", "connectionString", "*.connectionString"],
      censor: "[скрыто]",
    },
  });
}
