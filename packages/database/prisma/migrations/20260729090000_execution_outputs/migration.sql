-- A workflow can now read a datum from the page — the value of a field, the
-- state of a checkbox, the text of an element — and file it under a name.
--
-- The type is decided once, when the value is read, and kept beside the text it
-- came from: `raw` is what was actually on the page, and is the only thing that
-- can be shown without lying when the interpretation turns out wrong.
ALTER TABLE "workflow_steps" ADD COLUMN "outputName" TEXT;

CREATE TABLE "execution_outputs" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT,
    "name" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "number" DOUBLE PRECISION,
    "boolean" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_outputs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "execution_outputs_executionId_idx" ON "execution_outputs"("executionId");

ALTER TABLE "execution_outputs" ADD CONSTRAINT "execution_outputs_executionId_fkey"
    FOREIGN KEY ("executionId") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
