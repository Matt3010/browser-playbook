import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { encryptSecret, decryptSecret } from "@app/shared";
import { requireAuth, currentUser } from "../auth";

/** Names must be usable inside {{variables.x}} / {{credentials.x}} templates. */
const NameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_]+$/, "name may only contain letters, digits and underscores");

const UpsertSchema = z.object({
  name: NameSchema,
  value: z.string().max(4000),
  kind: z.enum(["variable", "secret"])
});

const UpdateSchema = z.object({
  value: z.string().max(4000)
});

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /**
   * Lists variables and credentials. Secret values are never returned: once
   * saved, a credential is write-only through the API.
   */
  app.get("/", async (request) => {
    const { userId } = currentUser(request);
    const rows = await app.prisma.credential.findMany({
      where: { userId },
      orderBy: [{ kind: "asc" }, { name: "asc" }]
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      value: row.kind === "variable" ? decryptSecret(row.encryptedValue, app.config.credentialsEncKey) : null,
      hasValue: row.encryptedValue.length > 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  });

  app.post("/", async (request, reply) => {
    const { userId } = currentUser(request);
    const parsed = UpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid payload",
        details: parsed.error.issues.map((i) => i.message)
      });
    }
    const { name, value, kind } = parsed.data;
    const encryptedValue = encryptSecret(value, app.config.credentialsEncKey);

    const row = await app.prisma.credential.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, kind, encryptedValue },
      update: { kind, encryptedValue }
    });

    return reply.code(201).send({
      id: row.id,
      name: row.name,
      kind: row.kind,
      value: row.kind === "variable" ? value : null
    });
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { userId } = currentUser(request);
    const parsed = UpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "value is required" });
    }
    const existing = await app.prisma.credential.findFirst({
      where: { id: request.params.id, userId }
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    const row = await app.prisma.credential.update({
      where: { id: existing.id },
      data: { encryptedValue: encryptSecret(parsed.data.value, app.config.credentialsEncKey) }
    });
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      value: row.kind === "variable" ? parsed.data.value : null
    };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { userId } = currentUser(request);
    const existing = await app.prisma.credential.findFirst({
      where: { id: request.params.id, userId }
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await app.prisma.credential.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });
}
