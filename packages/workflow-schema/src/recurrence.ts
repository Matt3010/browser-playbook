import { z } from "zod";
import { isValidTimezone } from "./schedule";

/**
 * A schedule that repeats, described the way a person says it — every day at
 * seven, every Monday, the first of the month — rather than as a cron line.
 *
 * The cron expression is derived from it, never typed: a workflow acts on a real
 * site, and `0 3 * * *` versus `3 0 * * *` is the difference between three in
 * the morning and three minutes past midnight, which nobody notices until it has
 * happened. What the user picks is what the list can read back to them.
 */
export const RecurrenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("minutes"),
    /**
     * How many minutes apart. Anything shorter than a run is asking for
     * occurrences to pile up, which the worker refuses rather than queues.
     */
    every: z.number().int().min(1).max(59)
  }),
  z.object({
    kind: z.literal("hourly"),
    /** Minute of every hour. */
    minute: z.number().int().min(0).max(59)
  }),
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM")
  }),
  z.object({
    kind: z.literal("weekly"),
    /** 0 is Sunday, as cron counts them. */
    weekday: z.number().int().min(0).max(6),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM")
  }),
  z.object({
    kind: z.literal("monthly"),
    /**
     * Capped at 28 on purpose: a workflow set for the 31st would simply not run
     * in February, and a schedule that silently skips a month is worse than one
     * that runs a few days early.
     */
    day: z.number().int().min(1).max(28),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM")
  })
]);

export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const RecurringScheduleInputSchema = z.object({
  recurrence: RecurrenceSchema,
  timezone: z.string().refine(isValidTimezone, { message: "Invalid IANA timezone" })
});

export type RecurringScheduleInput = z.infer<typeof RecurringScheduleInputSchema>;

export interface RecurrenceValidationResult {
  valid: boolean;
  errors: string[];
  /** The five-field cron expression the queue repeats on. */
  cron?: string;
  timezone?: string;
}

function hourAndMinute(time: string): [number, number] {
  const [hour, minute] = time.split(":");
  return [Number(hour), Number(minute)];
}

/** The cron expression a recurrence stands for: minute hour day month weekday. */
export function recurrenceToCron(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case "minutes":
      return `*/${recurrence.every} * * * *`;
    case "hourly":
      return `${recurrence.minute} * * * *`;
    case "daily": {
      const [hour, minute] = hourAndMinute(recurrence.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekly": {
      const [hour, minute] = hourAndMinute(recurrence.time);
      return `${minute} ${hour} * * ${recurrence.weekday}`;
    }
    case "monthly": {
      const [hour, minute] = hourAndMinute(recurrence.time);
      return `${minute} ${hour} ${recurrence.day} * *`;
    }
  }
}

export function validateRecurringSchedule(input: unknown): RecurrenceValidationResult {
  const parsed = RecurringScheduleInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    };
  }
  return {
    valid: true,
    errors: [],
    cron: recurrenceToCron(parsed.data.recurrence),
    timezone: parsed.data.timezone
  };
}

/** True when a schedule payload asks for a recurrence rather than one instant. */
export function isRecurringInput(input: unknown): boolean {
  return typeof input === "object" && input !== null && "recurrence" in input;
}
