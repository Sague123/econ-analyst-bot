import { afterEach, describe, expect, it } from "vitest";
import {
  formatLocal,
  localDayBounds,
  nextLocalTime,
  parseInstant,
  TimeError,
  TZ_PRAGUE,
  TZ_US_EASTERN,
  usEasternToUtc,
  utcOffsetMinutes,
  zonedToUtc,
} from "../../src/common/time.js";

/**
 * Переводы часов:
 * 2026 — США 8 марта и 1 ноября, Европа 29 марта и 25 октября;
 * 2027 — США 14 марта и 7 ноября, Европа 28 марта и 31 октября.
 * Между этими датами Нью-Йорк и Прагу разделяют 5 часов, а не 6.
 */

const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

describe("релиз в 8:30 по Вашингтону: UTC и Прага в недели расхождения", () => {
  const cases: Array<[string, [number, number, number], string, string]> = [
    // осень 2026
    ["до перевода в Европе", [2026, 10, 22], "2026-10-22T12:30:00Z", "22.10.2026 14:30"],
    ["Европа уже на зимнем, США ещё нет", [2026, 10, 28], "2026-10-28T12:30:00Z", "28.10.2026 13:30"],
    ["последний день расхождения", [2026, 10, 30], "2026-10-30T12:30:00Z", "30.10.2026 13:30"],
    ["обе на зимнем", [2026, 11, 4], "2026-11-04T13:30:00Z", "04.11.2026 14:30"],
    // весна 2026
    ["обе на зимнем", [2026, 3, 4], "2026-03-04T13:30:00Z", "04.03.2026 14:30"],
    ["США уже на летнем, Европа ещё нет", [2026, 3, 11], "2026-03-11T12:30:00Z", "11.03.2026 13:30"],
    ["последняя неделя расхождения", [2026, 3, 27], "2026-03-27T12:30:00Z", "27.03.2026 13:30"],
    ["обе на летнем", [2026, 4, 1], "2026-04-01T12:30:00Z", "01.04.2026 14:30"],
    // 2027: другие даты переводов
    ["весна 2027, до перевода в США", [2027, 3, 12], "2027-03-12T13:30:00Z", "12.03.2027 14:30"],
    ["весна 2027, расхождение", [2027, 3, 17], "2027-03-17T12:30:00Z", "17.03.2027 13:30"],
    ["осень 2027, до перевода в Европе", [2027, 10, 27], "2027-10-27T12:30:00Z", "27.10.2027 14:30"],
    ["осень 2027, расхождение до 7 ноября", [2027, 11, 3], "2027-11-03T12:30:00Z", "03.11.2027 13:30"],
    ["осень 2027, обе на зимнем", [2027, 11, 10], "2027-11-10T13:30:00Z", "10.11.2027 14:30"],
  ];

  it.each(cases)("%s: %j", (_label, [y, m, d], utc, prague) => {
    const at = usEasternToUtc(y, m, d, 8, 30);
    expect(iso(at)).toBe(utc);
    expect(formatLocal(at)).toBe(prague);
  });

  it("решение FOMC в 14:00 по Вашингтону в неделю расхождения — 19:00 по Праге, а не 20:00", () => {
    const autumn = usEasternToUtc(2026, 10, 28, 14, 0);
    expect(iso(autumn)).toBe("2026-10-28T18:00:00Z");
    expect(formatLocal(autumn, "time")).toBe("19:00");
    const spring = usEasternToUtc(2026, 3, 18, 14, 0);
    expect(iso(spring)).toBe("2026-03-18T18:00:00Z");
    expect(formatLocal(spring, "time")).toBe("19:00");
    expect(formatLocal(usEasternToUtc(2026, 12, 9, 14, 0), "time")).toBe("20:00");
  });
});

describe("час перевода", () => {
  it("несуществующее время — ошибка", () => {
    expect(() => zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, TZ_US_EASTERN)).toThrow(TimeError);
    expect(() => zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, TZ_PRAGUE)).toThrow(/не существует/);
  });

  it("время, которое бывает дважды, — первое или второе по выбору", () => {
    const ny = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };
    expect(iso(zonedToUtc(ny, TZ_US_EASTERN))).toBe("2026-11-01T05:30:00Z");
    expect(iso(zonedToUtc(ny, TZ_US_EASTERN, "later"))).toBe("2026-11-01T06:30:00Z");
    const prague = { year: 2026, month: 10, day: 25, hour: 2, minute: 30 };
    expect(iso(zonedToUtc(prague, TZ_PRAGUE))).toBe("2026-10-25T00:30:00Z");
    expect(iso(zonedToUtc(prague, TZ_PRAGUE, "later"))).toBe("2026-10-25T01:30:00Z");
  });

  it("неверная дата — ошибка", () => {
    expect(() => zonedToUtc({ year: 2026, month: 2, day: 30, hour: 8, minute: 30 }, TZ_US_EASTERN)).toThrow(/неверное местное время/);
    expect(() => zonedToUtc({ year: 2026, month: 2, day: 3, hour: 24, minute: 0 }, TZ_US_EASTERN)).toThrow(TimeError);
  });

  it("смещения поясов", () => {
    expect(utcOffsetMinutes(new Date("2026-07-01T12:00:00Z"), TZ_PRAGUE)).toBe(120);
    expect(utcOffsetMinutes(new Date("2026-01-15T12:00:00Z"), TZ_PRAGUE)).toBe(60);
    expect(utcOffsetMinutes(new Date("2026-07-01T12:00:00Z"), TZ_US_EASTERN)).toBe(-240);
    expect(utcOffsetMinutes(new Date("2026-01-15T12:00:00Z"), TZ_US_EASTERN)).toBe(-300);
  });
});

describe("пражские сутки и дайджест в 08:00", () => {
  it("сутки перевода назад длятся 25 часов, вперёд — 23", () => {
    const autumn = localDayBounds(new Date("2026-10-25T12:00:00Z"));
    expect(iso(autumn.start)).toBe("2026-10-24T22:00:00Z");
    expect(iso(autumn.end)).toBe("2026-10-25T23:00:00Z");
    const spring = localDayBounds(new Date("2026-03-29T12:00:00Z"));
    expect(iso(spring.start)).toBe("2026-03-28T23:00:00Z");
    expect(iso(spring.end)).toBe("2026-03-29T22:00:00Z");
    const plain = localDayBounds(new Date("2026-11-26T23:30:00Z")); // по Праге уже 27-е
    expect(iso(plain.start)).toBe("2026-11-26T23:00:00Z");
    expect(iso(plain.end)).toBe("2026-11-27T23:00:00Z");
  });

  it("следующее 08:00 по Праге через перевод часов", () => {
    expect(iso(nextLocalTime(new Date("2026-10-24T05:00:00Z"), 8, 0))).toBe("2026-10-24T06:00:00Z"); // летнее
    expect(iso(nextLocalTime(new Date("2026-10-24T07:00:00Z"), 8, 0))).toBe("2026-10-25T07:00:00Z"); // уже зимнее
    expect(iso(nextLocalTime(new Date("2026-10-25T07:00:00Z"), 8, 0))).toBe("2026-10-26T07:00:00Z"); // строго после
    expect(iso(nextLocalTime(new Date("2026-03-28T08:00:00Z"), 8, 0))).toBe("2026-03-29T06:00:00Z"); // уже летнее
  });

  it("показ переходит через полночь по Праге, а не по UTC", () => {
    const d = new Date("2026-11-26T23:30:00Z");
    expect(formatLocal(d)).toBe("27.11.2026 00:30");
    expect(formatLocal(d, "date")).toBe("27.11.2026");
    expect(formatLocal(d, "datetime", "UTC")).toBe("26.11.2026 23:30");
  });
});

describe("строки времени", () => {
  it("принимает только моменты с явным поясом", () => {
    expect(iso(parseInstant("2026-10-28T12:30:00Z"))).toBe("2026-10-28T12:30:00Z");
    expect(iso(parseInstant("2026-10-28T13:30:00+01:00"))).toBe("2026-10-28T12:30:00Z");
    expect(parseInstant("2026-11-11T10:53:53.123Z").getTime()).toBe(Date.UTC(2026, 10, 11, 10, 53, 53, 123)); // как в Velora
    expect(() => parseInstant("2026-10-28T12:30:00")).toThrow(/без пояса/);
    expect(() => parseInstant("2026-10-28 12:30")).toThrow(TimeError);
    expect(() => parseInstant("28.10.2026")).toThrow(TimeError);
  });
});

describe("пояс процесса не влияет на результат", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"])("TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(iso(usEasternToUtc(2026, 10, 28, 8, 30))).toBe("2026-10-28T12:30:00Z");
    expect(formatLocal(new Date("2026-10-28T12:30:00Z"))).toBe("28.10.2026 13:30");
    expect(iso(localDayBounds(new Date("2026-10-25T12:00:00Z")).end)).toBe("2026-10-25T23:00:00Z");
    expect(iso(nextLocalTime(new Date("2026-10-24T07:00:00Z"), 8, 0))).toBe("2026-10-25T07:00:00Z");
  });
});
