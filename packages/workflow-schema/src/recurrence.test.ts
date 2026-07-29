import { describe, expect, it } from "vitest";
import {
  isRecurringInput,
  recurrenceToCron,
  validateRecurringSchedule,
  type Recurrence
} from "./recurrence";

describe("recurrenceToCron", () => {
  const cases: Array<[Recurrence, string]> = [
    [{ kind: "minutes", every: 1 }, "*/1 * * * *"],
    [{ kind: "minutes", every: 15 }, "*/15 * * * *"],
    [{ kind: "hourly", minute: 0 }, "0 * * * *"],
    [{ kind: "hourly", minute: 15 }, "15 * * * *"],
    [{ kind: "daily", time: "03:00" }, "0 3 * * *"],
    [{ kind: "daily", time: "23:45" }, "45 23 * * *"],
    // Leading zeros are hours, not octal: 07:05 is seven past five, in the morning.
    [{ kind: "daily", time: "07:05" }, "5 7 * * *"],
    [{ kind: "weekly", weekday: 1, time: "09:30" }, "30 9 * * 1"],
    [{ kind: "weekly", weekday: 0, time: "00:00" }, "0 0 * * 0"],
    [{ kind: "monthly", day: 1, time: "06:00" }, "0 6 1 * *"],
    [{ kind: "monthly", day: 28, time: "18:20" }, "20 18 28 * *"]
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
      recurrence: { kind: "daily", time: "03:00" },
      timezone: rome
    });
    expect(result).toMatchObject({ valid: true, cron: "0 3 * * *", timezone: rome });
  });

  it("refuses a day of the month that some months do not have", () => {
    // The 31st would simply not run in February, and a schedule that skips a
    // month without saying so is worse than one that runs a few days early.
    const result = validateRecurringSchedule({
      recurrence: { kind: "monthly", day: 31, time: "03:00" },
      timezone: rome
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/day/);
  });

  it("refuses a time that is not a time", () => {
    for (const time of ["24:00", "3:00", "0300", "12:60", ""]) {
      const result = validateRecurringSchedule({
        recurrence: { kind: "daily", time },
        timezone: rome
      });
      expect(result.valid, time).toBe(false);
    }
  });

  it("refuses a timezone that does not exist", () => {
    const result = validateRecurringSchedule({
      recurrence: { kind: "daily", time: "03:00" },
      timezone: "Europe/Atlantide"
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/timezone/i);
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
    expect(isRecurringInput({ recurrence: { kind: "daily", time: "03:00" } })).toBe(true);
    expect(isRecurringInput({ runAt: "2026-01-01T03:00:00Z" })).toBe(false);
    expect(isRecurringInput(null)).toBe(false);
    expect(isRecurringInput("recurrence")).toBe(false);
  });
});
