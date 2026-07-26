import type { FastifyInstance } from "fastify";
import { requireAuth, currentUser } from "../auth";

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request) => {
    const { userId } = currentUser(request);
    const [items, unread] = await Promise.all([
      app.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      app.prisma.notification.count({ where: { userId, readAt: null } })
    ]);
    return { items, unread };
  });

  app.post<{ Params: { id: string } }>("/:id/read", async (request, reply) => {
    const { userId } = currentUser(request);
    const existing = await app.prisma.notification.findFirst({
      where: { id: request.params.id, userId }
    });
    if (!existing) return reply.code(404).send({ error: "Notification not found" });
    return app.prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: existing.readAt ?? new Date() }
    });
  });

  app.post("/read-all", async (request) => {
    const { userId } = currentUser(request);
    const result = await app.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() }
    });
    return { updated: result.count };
  });
}
