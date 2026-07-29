import { describe, expect, it } from "vitest";
import {
  isRecurringInput,
  recurrenceToCron,
  validateRecurringSchedule,
  type Recurrence
} from "./recurrence";

describe("recurrenceToCron", () => {
  const cases: Array<[Recurrence, string]> = [
    // An interval of one is every one: a bare star, because `*/1` says the same
    // thing and reads like a mistake.
    [{ kind: "minutes", every: 1 }, "* * * * *"],
    [{ kind: "minutes", every: 5 }, "*/5 * * * *"],
    [{ kind: "minutes", every: 15 }, "*/15 * * * *"],
    [{ kind: "hours", every: 1, minute: 0 }, "0 * * * *"],
    [{ kind: "hours", every: 1, minute: 15 }, "15 * * * *"],
    [{ kind: "hours", every: 4, minute: 30 }, "30 */4 * * *"],
    [{ kind: "days", every: 1, time: "03:00" }, "0 3 * * *"],
    [{ kind: "days", every: 3, time: "07:30" }, "30 7 */3 * *"],
    [{ kind: "days", every: 1, time: "23:45" }, "45 23 * * *"],
    // Leading zeros are hours, not octal: 07:05 is seven past five, in the morning.
    [{ kind: "days", every: 1, time: "07:05" }, "5 7 * * *"],
    [{ kind: "weekly", weekday: 1, time: "09:30" }, "30 9 * * 1"],
    [{ kind: "months", every: 1, day: 1, time: "06:00" }, "0 6 1 * *"],
    [{ kind: "months", every: 3, day: 1, time: "06:00" }, "0 6 1 */3 *"],
    [{ kind: "months", every: 6, day: 15, time: "18:20" }, "20 18 15 */6 *"],
    [{ kind: "weekly", weekday: 0, time: "00:00" }, "0 0 * * 0"],
        [{ kind: "months", every: 1, day: 28, time: "18:20" }, "20 18 28 * *"]
  ];

  for (const [recurrence, cron] of cases) {
    it(`turns ${JSON.stringify(recurrence)} into ${cron}`, () => {
      expect(recurrenceToCron(recurrence)).toBe(cron);
    });
  }
});

describe("validateRecurringSchedule", () => {
  const rome = "Europe/Rome";

  it("accepts a daily recurrence and returns its cron", () => {
    const result = validateRecurringSchedule({
      recurrence: { kind: "days", every: 1, time: "03:00" },
      timezone: rome
    });
    expect(result).toMatchObject({ valid: true, cron: "0 3 * * *", timezone: rome });
  });

  it("refuses a day of the month that some months do not have", () => {
    // The 31st would simply not run in February, and a schedule that skips a
    // month without saying so is worse than one that runs a few days early.
    const result = validateRecurringSchedule({
      recurrence: { kind: "months", every: 1, day: 31, time: "03:00" },
      timezone: rome
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/day/);
  });

  it("refuses a time that is not a time", () => {
    for (const time of ["24:00", "3:00", "0300", "12:60", ""]) {
      const result = validateRecurringSchedule({
        recurrence: { kind: "days", every: 1, time },
        timezone: rome
      });
      expect(result.valid, time).toBe(false);
    }
  });

  it("refuses a timezone that does not exist", () => {
    const result = validateRecurringSchedule({
      recurrence: { kind: "days", every: 1, time: "03:00" },
      timezone: "Europe/Atlantide"
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/timezone/i);
  });

  it("refuses a month interval that is not one", () => {
    for (const every of [0, 13, -1]) {
      expect(
        validateRecurringSchedule({
          recurrence: { kind: "months", every, day: 1, time: "06:00" },
          timezone: rome
        }).valid,
        String(every)
      ).toBe(false);
    }
  });

  it("refuses an interval that is not one", () => {
    // Every zero hours is not a schedule, and a day every forty is a mistake
    // waiting to be discovered a month later.
    const bad: Array<Record<string, unknown>> = [
      { kind: "hours", every: 0, minute: 0 },
      { kind: "hours", every: 24, minute: 0 },
      { kind: "hours", every: 2, minute: 60 },
      { kind: "days", every: 0, time: "03:00" },
      { kind: "days", every: 40, time: "03:00" }
    ];
    for (const recurrence of bad) {
      expect(
        validateRecurringSchedule({ recurrence, timezone: rome }).valid,
        JSON.stringify(recurrence)
      ).toBe(false);
    }
  });

  it("refuses an interval of no minutes, or of more than an hour", () => {
    for (const every of [0, -5, 60, 1440]) {
      expect(
        validateRecurringSchedule({ recurrence: { kind: "minutes", every }, timezone: rome }).valid,
        String(every)
      ).toBe(false);
    }
  });

  it("refuses a weekday outside the week", () => {
    expect(
      validateRecurringSchedule({
        recurrence: { kind: "weekly", weekday: 7, time: "03:00" },
        timezone: rome
      }).valid
    ).toBe(false);
  });

  it("refuses a recurrence of an unknown kind", () => {
    expect(
      validateRecurringSchedule({
        recurrence: { kind: "fortnightly", time: "03:00" },
        timezone: rome
      }).valid
    ).toBe(false);
  });
});

describe("isRecurringInput", () => {
  it("tells the two kinds of schedule apart", () => {
    expect(isRecurringInput({ recurrence: { kind: "days", every: 1, time: "03:00" } })).toBe(true);
    expect(isRecurringInput({ runAt: "2026-01-01T03:00:00Z" })).toBe(false);
    expect(isRecurringInput(null)).toBe(false);
    expect(isRecurringInput("recurrence")).toBe(false);
  });
});
