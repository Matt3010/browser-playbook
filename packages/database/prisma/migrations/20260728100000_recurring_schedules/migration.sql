-- Recurring schedules: a workflow that runs every day, every week or every
-- month rather than once at an instant.
--
-- `runAt` becomes nullable because a recurrence has no single instant, and the
-- existing one-shot rows keep theirs. `cron` is what the queue repeats on; it
-- is derived from the recurrence the user picked, never typed by hand.
ALTER TABLE "schedules" ALTER COLUMN "runAt" DROP NOT NULL;
ALTER TABLE "schedules" ADD COLUMN "cron" TEXT;
