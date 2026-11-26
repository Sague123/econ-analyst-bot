/**
 * Время. В базе и коде — только моменты в UTC (Date, timestamptz).
 * Часовые пояса появляются в двух местах:
 * 1. на входе: ведомства публикуют расписание в местном времени
 *    («8:30 по Вашингтону»), его переводим в UTC здесь;
 * 2. на выходе: пользователю показываем время по Праге.
 * Функции не зависят от пояса процесса (TZ): всё считается через Intl с явным поясом.
 *
 * США и Европа переводят часы в разные дни, поэтому разница между ними
 * дважды в год три недели (март) и неделю (конец октября) не 6 часов, а 5.
 */

export const TZ_PRAGUE = "Europe/Prague";
export const TZ_US_EASTERN = "America/New_York";

export interface WallTime {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

export class TimeError extends Error {
  override name = "TimeError";
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Местное время в поясе tz для момента. */
export function wallTimeIn(date: Date, tz: string): Required<WallTime> {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(date)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

/** Смещение пояса от UTC в минутах для момента: Прага зимой +60, летом +120; Нью-Йорк −300 / −240. */
export function utcOffsetMinutes(date: Date, tz: string): number {
  const w = wallTimeIn(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

const wallMs = (w: WallTime) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);
const sameWall = (a: WallTime, b: WallTime) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && (a.second ?? 0) === (b.second ?? 0);

/**
 * Местное время в поясе → момент UTC.
 * Несуществующее время (час перевода вперёд) — ошибка: расписание с таким временем неверно.
 * Время, которое бывает дважды (час перевода назад), — по умолчанию первое из двух.
 */
export function zonedToUtc(w: WallTime, tz: string, ambiguous: "earlier" | "later" = "earlier"): Date {
  validateWall(w);
  const target = wallMs(w);
  // Смещения за сутки до и после покрывают любой перевод часов рядом с этим временем.
  const offsets = new Set([utcOffsetMinutes(new Date(target - 86_400_000), tz), utcOffsetMinutes(new Date(target + 86_400_000), tz)]);
  const candidates = [...offsets]
    .map((off) => target - off * 60_000)
    .filter((t) => sameWall(wallTimeIn(new Date(t), tz), w))
    .sort((a, b) => a - b);
  if (candidates.length === 0) throw new TimeError(`${fmtWall(w)} не существует в поясе ${tz}: в этот час переводят часы вперёд`);
  return new Date(ambiguous === "later" ? candidates.at(-1)! : candidates[0]!);
}

function validateWall(w: WallTime): void {
  const t = new Date(wallMs(w));
  const ok =
    Number.isInteger(w.year) &&
    t.getUTCFullYear() === w.year &&
    t.getUTCMonth() === w.month - 1 &&
    t.getUTCDate() === w.day &&
    w.hour >= 0 &&
    w.hour <= 23 &&
    w.minute >= 0 &&
    w.minute <= 59 &&
    (w.second ?? 0) >= 0 &&
    (w.second ?? 0) <= 59;
  if (!ok) throw new TimeError(`неверное местное время ${fmtWall(w)}`);
}

const pad = (n: number) => String(n).padStart(2, "0");
function fmtWall(w: WallTime): string {
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** Время релиза по Вашингтону («8:30 ET») → момент UTC. */
export function usEasternToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  return zonedToUtc({ year, month, day, hour, minute }, TZ_US_EASTERN);
}

export type DisplayStyle = "datetime" | "date" | "time";

/** Показ: «28.10.2026 13:30», «28.10.2026», «13:30». По умолчанию — Прага. */
export function formatLocal(date: Date, style: DisplayStyle = "datetime", tz: string = TZ_PRAGUE): string {
  const w = wallTimeIn(date, tz);
  const d = `${pad(w.day)}.${pad(w.month)}.${w.year}`;
  const t = `${pad(w.hour)}:${pad(w.minute)}`;
  return style === "date" ? d : style === "time" ? t : `${d} ${t}`;
}

/** Пражские сутки, в которые попадает момент: [начало, конец) в UTC. В дни перевода часов — 23 или 25 часов. */
export function localDayBounds(date: Date, tz: string = TZ_PRAGUE): { start: Date; end: Date } {
  const w = wallTimeIn(date, tz);
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return {
    start: zonedToUtc({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0 }, tz),
    end: zonedToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }, tz),
  };
}

/** Ближайшее после `after` наступление местного времени hh:mm (дайджест в 08:00 по Праге). */
export function nextLocalTime(after: Date, hour: number, minute: number, tz: string = TZ_PRAGUE): Date {
  const w = wallTimeIn(after, tz);
  for (let add = 0; add <= 2; add++) {
    const day = new Date(Date.UTC(w.year, w.month - 1, w.day + add));
    const candidate = zonedToUtc({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, tz);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new TimeError(`не нашёл ${pad(hour)}:${pad(minute)} после ${after.toISOString()} в поясе ${tz}`);
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Строка с явным поясом (…Z или …+02:00) → Date. Без пояса — ошибка: такое время двусмысленно. */
export function parseInstant(s: string): Date {
  const v = s.trim();
  if (!ISO_WITH_ZONE.test(v)) throw new TimeError(`время без пояса или не ISO 8601: ${JSON.stringify(s)}`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new TimeError(`неверное время: ${JSON.stringify(s)}`);
  return d;
}
