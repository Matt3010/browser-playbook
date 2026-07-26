import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { getPrisma, NotificationService, type PrismaClient } from "@app/database";
import type { Config } from "./config";
import { ExecutionQueue } from "./queue";
import { WorkerClient } from "./worker-client";
import { NotFoundError } from "./ownership";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { workflowRoutes } from "./routes/workflows";
import { credentialRoutes } from "./routes/credentials";
import { executionRoutes } from "./routes/executions";
import { scheduleRoutes } from "./routes/schedules";
import { notificationRoutes } from "./routes/notifications";
import { sessionRoutes } from "./routes/sessions";
import "./types";

export interface BuildAppOptions {
  config: Config;
  prisma?: PrismaClient;
  queue?: ExecutionQueue;
  worker?: WorkerClient;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "body.password",
          "body.value",
          "res.headers['set-cookie']"
        ],
        censor: "[REDACTED]"
      }
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024
  });

  const prisma = options.prisma ?? getPrisma();
  const queue = options.queue ?? new ExecutionQueue(config.redisUrl);
  const worker = options.worker ?? new WorkerClient(config.workerUrl);

  app.decorate("config", config);
  app.decorate("prisma", prisma);
  app.decorate("queue", queue);
  app.decorate("worker", worker);
  app.decorate("notifications", new NotificationService(prisma));

  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: "1 minute",
    // Health probes and the long-lived SSE/VNC streams must not be throttled.
    allowList: (request) =>
      request.url === "/health" ||
      request.url === "/ready" ||
      request.url.includes("/logs/stream") ||
      request.url.includes("/vnc")
  });
  await app.register(websocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: "Too many requests, slow down" });
    }
    request.log.error({ err: error }, "Unhandled API error");
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? "Internal server error" : error.message });
  });

  await app.register(healthRoutes);
  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(workflowRoutes, { prefix: "/api/workflows" });
  await app.register(credentialRoutes, { prefix: "/api/credentials" });
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  await app.register(sessionRoutes, { prefix: "/api/sessions" });
  await app.register(executionRoutes, { prefix: "/api" });
  await app.register(scheduleRoutes, { prefix: "/api" });

  app.addHook("onClose", async () => {
    await queue.close();
  });

  return app;
}
