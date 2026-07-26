import { rm } from "fs/promises";
import path from "path";
import type { PrismaClient } from "@app/database";
import type { Logger } from "@app/shared";

export interface PruneResult {
  /** Executions whose logs and artifacts were pruned. */
  executions: number;
  logs: number;
  artifacts: number;
  notifications: number;
}

/**
 * Removes history nobody is going to read again.
 *
 * Nothing used to delete an execution log, a notification or a screenshot: they
 * only disappeared when the whole workflow was deleted. Every run writes several
 * log lines and every failed run writes a screenshot, so on a Raspberry Pi with an
 * SD card a workflow running nightly grows the database and the volume without a
 * ceiling.
 *
 * The execution rows themselves are kept: one row each, and they are the history the
 * user looks at. What goes is the bulk — the log lines and the files.
 */
export async function pruneOldHistory(deps: {
  prisma: PrismaClient;
  log: Logger;
  artifactDir: string;
  retentionDays: number;
  now?: Date;
}): Promise<PruneResult> {
  const { prisma, log, artifactDir, retentionDays } = deps;
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Only finished runs: an execution still going has no finishedAt, and reading
  // that as "infinitely old" would delete the log of the run currently streaming
  // to the user.
  const stale = await prisma.execution.findMany({
    where: { finishedAt: { not: null, lt: cutoff } },
    select: { id: true }
  });
  const ids = stale.map((execution) => execution.id);

  let logs = 0;
  let artifacts = 0;
  if (ids.length > 0) {
    const artifactRows = await prisma.artifact.findMany({
      where: { executionId: { in: ids } },
      select: { path: true }
    });
    logs = (await prisma.executionLog.deleteMany({ where: { executionId: { in: ids } } })).count;
    artifacts = (await prisma.artifact.deleteMany({ where: { executionId: { in: ids } } })).count;

    const root = path.resolve(artifactDir);
    for (const row of artifactRows) {
      // The stored path is data. Whatever it says, nothing outside the artifact
      // root may be removed.
      const resolved = path.resolve(row.path);
      if (!resolved.startsWith(root + path.sep)) {
        log.warn({ path: row.path }, "Refusing to prune an artifact outside the artifact root");
        continue;
      }
      try {
        await rm(resolved, { force: true, maxRetries: 2 });
      } catch (err) {
        log.warn({ err, path: resolved }, "Could not remove a pruned artifact file");
      }
    }
    // The per-execution directories are left empty by the loop above; drop them too.
    for (const id of ids) {
      const directory = path.resolve(root, id);
      if (directory !== path.join(root, id)) continue;
      if (!directory.startsWith(root + path.sep)) continue;
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      } catch (err) {
        log.warn({ err, directory }, "Could not remove a pruned artifact directory");
      }
    }
  }

  const notifications = (
    await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } })
  ).count;

  if (ids.length > 0 || notifications > 0) {
    log.info(
      { executions: ids.length, logs, artifacts, notifications, retentionDays },
      "Pruned old history"
    );
  }

  return { executions: ids.length, logs, artifacts, notifications };
}
