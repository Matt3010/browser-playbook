import type { PrismaClient, NotificationService } from "@app/database";
import type { Config } from "./config";
import type { ExecutionQueue } from "./queue";
import type { WorkerClient } from "./worker-client";

export interface AuthUser {
  userId: string;
  email: string;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    prisma: PrismaClient;
    queue: ExecutionQueue;
    worker: WorkerClient;
    notifications: NotificationService;
  }
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}
