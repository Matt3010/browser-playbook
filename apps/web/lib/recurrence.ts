import type { Recurrence } from "@/lib/api";

export const WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

/** A recurrence as a sentence, because "0 3 * * 1" is not one. */
export function describeRecurrence(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case "minutes":
      return recurrence.every === 1 ? "ogni minuto" : `ogni ${recurrence.every} minuti`;
    case "hours":
      return recurrence.every === 1
        ? `ogni ora al minuto ${recurrence.minute}`
        : `ogni ${recurrence.every} ore al minuto ${recurrence.minute}`;
    case "days":
      return recurrence.every === 1
        ? `ogni giorno alle ${recurrence.time}`
        : `ogni ${recurrence.every} giorni alle ${recurrence.time}`;
    case "weekly":
      return `ogni ${WEEKDAYS[recurrence.weekday]} alle ${recurrence.time}`;
    case "months":
      return recurrence.every === 1
        ? `il ${recurrence.day} di ogni mese alle ${recurrence.time}`
        : `il ${recurrence.day} ogni ${recurrence.every} mesi alle ${recurrence.time}`;
  }
}

/** The step of a cron field: a bare star is every one, a step of three every third. */
function stepOf(field: string): number {
  return field.startsWith("*/") ? Number(field.slice(2)) : 1;
}

/**
 * The same sentence, read back from what was stored. The cron expression is
 * derived from the recurrence, so it can be read back into one — and a schedule
 * whose line the user cannot read is a schedule they cannot check.
 */
export function describeCron(cron: string): string {
  const [minute, hour, day, month, weekday] = cron.split(" ");
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

  if (hour === "*" || hour.startsWith("*/")) {
    if (minute === "*" || minute.startsWith("*/")) {
      return describeRecurrence({ kind: "minutes", every: stepOf(minute) });
    }
    return describeRecurrence({ kind: "hours", every: stepOf(hour), minute: Number(minute) });
  }
  if (weekday !== "*") {
    return describeRecurrence({ kind: "weekly", weekday: Number(weekday), time });
  }
  // The day field is either a step — every N days — or the day of the month a
  // monthly schedule lands on. A step is not a day number.
  if (day === "*" || day.startsWith("*/")) {
    return describeRecurrence({ kind: "days", every: stepOf(day), time });
  }
  return describeRecurrence({
    kind: "months",
    every: stepOf(month),
    day: Number(day),
    time
  });
}
