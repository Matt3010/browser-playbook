import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: the process is up and serving. */
  app.get("/health", async () => ({ status: "ok", service: "api" }));

  /** Readiness: every dependency the API needs is reachable. */
  app.get("/ready", async (_request, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      await app.prisma.$queryRaw`SELECT 1`;
      checks.postgres = "ok";
    } catch (err) {
      checks.postgres = `error: ${(err as Error).message}`;
      ready = false;
    }

    try {
      checks.redis = (await app.queue.ping()) ? "ok" : "error: unexpected ping reply";
      if (checks.redis !== "ok") ready = false;
    } catch (err) {
      checks.redis = `error: ${(err as Error).message}`;
      ready = false;
    }

    try {
      const workerHealth = await app.worker.health();
      checks.worker = workerHealth.status === "ok" ? "ok" : `error: ${workerHealth.status}`;
      if (checks.worker !== "ok") ready = false;
    } catch (err) {
      checks.worker = `error: ${(err as Error).message}`;
      ready = false;
    }

    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
  });
}
