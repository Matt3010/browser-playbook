import { describe, expect, it } from "vitest";
import { validateSchedule, isValidTimezone, MIN_SCHEDULE_LEAD_MS } from "./schedule";

const now = new Date("2026-07-26T10:00:00.000Z");

describe("schedule validation", () => {
  it("accepts a future instant with a valid timezone", () => {
    const result = validateSchedule(
      { runAt: "2026-07-26T10:05:00.000Z", timezone: "Europe/Rome" },
      now
    );
    expect(result.valid).toBe(true);
    expect(result.delayMs).toBe(5 * 60 * 1000);
  });

  it("rejects a past instant", () => {
    const result = validateSchedule(
      { runAt: "2026-07-26T09:00:00.000Z", timezone: "Europe/Rome" },
      now
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/at least 1 second in the future/);
  });

  it("rejects an instant below the minimum lead time", () => {
    const runAt = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS - 1).toISOString();
    expect(validateSchedule({ runAt, timezone: "UTC" }, now).valid).toBe(false);
  });

  it("rejects an instant more than a year ahead", () => {
    const result = validateSchedule({ runAt: "2030-01-01T00:00:00.000Z", timezone: "UTC" }, now);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/within one year/);
  });

  it("rejects an invalid timezone", () => {
    const result = validateSchedule(
      { runAt: "2026-07-26T11:00:00.000Z", timezone: "Mars/Olympus" },
      now
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/timezone/i);
  });

  it("rejects a non ISO-8601 runAt", () => {
    expect(validateSchedule({ runAt: "tomorrow", timezone: "UTC" }, now).valid).toBe(false);
    expect(validateSchedule({ runAt: "2026-07-26", timezone: "UTC" }, now).valid).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(validateSchedule({}, now).valid).toBe(false);
    expect(validateSchedule({ runAt: "2026-07-26T11:00:00.000Z" }, now).valid).toBe(false);
  });

  it("validates IANA timezones", () => {
    expect(isValidTimezone("Europe/Rome")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});
