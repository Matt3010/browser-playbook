import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { encryptSecret, decryptSecret, extractTemplateRefs } from "@app/shared";
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

/**
 * Names of the workflows whose enabled steps reference this value. A disabled step
 * never runs, so it cannot be broken by the deletion and is not counted.
 */
async function workflowsReferencing(
  app: FastifyInstance,
  userId: string,
  name: string,
  kind: string
): Promise<string[]> {
  const wanted = kind === "secret" ? "credentials" : "variables";
  const workflows = await app.prisma.workflow.findMany({
    where: { userId },
    select: { name: true, steps: { select: { valueTemplate: true, enabled: true } } }
  });
  return workflows
    .filter((workflow) =>
      workflow.steps.some(
        (step) =>
          step.enabled &&
          step.valueTemplate &&
          extractTemplateRefs(step.valueTemplate).some(
            (ref) => ref.kind === wanted && ref.key === name
          )
      )
    )
    .map((workflow) => workflow.name);
}

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
    return rows.map((row) => {
      // Emptiness is a property of the value, not of the ciphertext: encrypting
      // "" still produces an iv and a tag, so the stored length says nothing.
      // A name now exists as soon as a step mentions it, so this is what tells
      // an entry waiting to be filled from one that is ready to be used.
      const plain = decryptSecret(row.encryptedValue, app.config.credentialsEncKey);
      return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      value: row.kind === "variable" ? plain : null,
      hasValue: plain.length > 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
      };
    });
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

    // Removing a value a workflow still names does not break the run halfway — the
    // pre-flight refuses to start — but the user would only discover it the next time
    // they run the workflow, or worse, when a scheduled run failed overnight. Say it
    // now, at the moment the decision is being made.
    const users = await workflowsReferencing(app, userId, existing.name, existing.kind);
    if (users.length > 0) {
      return reply.code(409).send({
        error:
          `'${existing.name}' is used by ${users.join(", ")}. ` +
          "Remove the reference from those workflows first, or the runs would refuse to start.",
        workflows: users
      });
    }

    await app.prisma.credential.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });
}
