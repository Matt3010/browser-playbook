-- Adds the closing-action flag: a step recorded without being performed, which
-- must be the last enabled step of its workflow.
ALTER TABLE "workflow_steps" ADD COLUMN "isFinal" BOOLEAN NOT NULL DEFAULT false;
