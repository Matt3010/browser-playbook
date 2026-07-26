import { z } from "zod";

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export const ScheduleInputSchema = z.object({
  /** ISO-8601 instant at which the single future execution must start. */
  runAt: z.string().datetime({ offset: true }),
  timezone: z.string().refine(isValidTimezone, { message: "Invalid IANA timezone" })
});

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export interface ScheduleValidationResult {
  valid: boolean;
  errors: string[];
  delayMs?: number;
}

/** Minimum lead time so the queue has a chance to persist the job first. */
export const MIN_SCHEDULE_LEAD_MS = 1000;
export const MAX_SCHEDULE_LEAD_MS = 1000 * 60 * 60 * 24 * 365;

export function validateSchedule(
  input: unknown,
  now: Date = new Date()
): ScheduleValidationResult {
  const parsed = ScheduleInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    };
  }
  const runAt = new Date(parsed.data.runAt);
  const delayMs = runAt.getTime() - now.getTime();
  if (delayMs < MIN_SCHEDULE_LEAD_MS) {
    return { valid: false, errors: ["runAt must be at least 1 second in the future"] };
  }
  if (delayMs > MAX_SCHEDULE_LEAD_MS) {
    return { valid: false, errors: ["runAt must be within one year"] };
  }
  return { valid: true, errors: [], delayMs };
}
