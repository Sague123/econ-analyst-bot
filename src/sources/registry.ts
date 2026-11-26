import type { SourceRegistration } from "../common/health.js";
import type { LimiterSpec } from "../common/limiter.js";

/**
 * Источники этапов 0–1: условия, лимиты и порог свежести.
 * Лимиты — из документации источников (таблица в docs/PLAN-MVP.md).
 * Где лимит не опубликован, стоит вежливый, он помечен «свой».
 * Окна скользящие, поэтому документированный лимит не превышается ни в каком
 * календарном окне источника. Порог свежести — через сколько без удачного
 * ответа данные помечаются устаревшими.
 */

export interface SourceDef extends SourceRegistration {
  /** Лимиты HTTP; у источников-баз (Flowscope, Velora) их нет. */
  limits?: LimiterSpec;
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SOURCES = {
  flowscope: {
    id: "flowscope",
    name: "Flowscope (своя БД)",
    termsNote: "свои данные; роль analyst_ro только на чтение",
    staleAfterMs: 5 * MIN,
  },
  velora_news: {
    id: "velora_news",
    name: "Velora, новости",
    termsNote: "заголовок, ссылка, свой пересказ; без полного текста",
    // Velora опрашивает ленты раз в 5 минут; ночью новостей бывает мало, поэтому с запасом.
    staleAfterMs: 45 * MIN,
  },
  bls: {
    id: "bls",
    name: "BLS API v2",
    termsNote: "общественное достояние, просят ссылку на BLS",
    // Опрашивается вокруг релизов, а не непрерывно.
    staleAfterMs: 7 * DAY,
    limits: {
      requests: [
        { limit: 50, intervalMs: 10 * SEC },
        { limit: 500, intervalMs: DAY, persist: true },
      ],
    },
  },
  bea: {
    id: "bea",
    name: "BEA API",
    termsNote: "условия API BEA",
    staleAfterMs: 7 * DAY,
    limits: {
      requests: [{ limit: 100, intervalMs: MIN }],
      errors: [{ limit: 30, intervalMs: MIN }],
    },
  },
  fed: {
    id: "fed",
    name: "Федрезерв, RSS",
    termsNote: "публичные документы",
    staleAfterMs: 30 * MIN,
    limits: { requests: [{ limit: 1, intervalMs: SEC }] }, // свой
  },
  sec: {
    id: "sec",
    name: "SEC, пресс-релизы",
    termsNote: "федеральные данные; User-Agent «компания email»",
    staleAfterMs: 30 * MIN,
    limits: { requests: [{ limit: 10, intervalMs: SEC }] },
  },
  binance_dv: {
    id: "binance_dv",
    name: "Binance Data Vision",
    termsNote: "архив свечей; сырые данные не распространять",
    // Только для догрузки истории скриптом.
    staleAfterMs: 30 * DAY,
    limits: { requests: [{ limit: 2, intervalMs: SEC }] }, // свой
  },
} as const satisfies Record<string, SourceDef>;

export type SourceId = keyof typeof SOURCES;
export const ALL_SOURCES: readonly SourceDef[] = Object.values(SOURCES);
