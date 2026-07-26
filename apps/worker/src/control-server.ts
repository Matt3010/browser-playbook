import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Logger } from "@app/shared";
import type { WorkerConfig } from "./config";
import {
  SessionManager,
  SessionLimitError,
  SessionNotFoundError
} from "./session/manager";

const CreateSessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  startUrl: z.string().url(),
  timeoutMs: z.coerce.number().int().min(1000).optional()
});

const ToggleSchema = z.object({ enabled: z.boolean() });
const NavigateSchema = z.object({ url: z.string().url() });
const WaitSchema = z.object({ ms: z.coerce.number().int().min(0).max(120_000) });

const InteractSchema = z.object({
  kind: z.enum(["click", "fill", "select", "check", "uncheck", "press"]),
  selector: z.string().min(1).max(500).optional(),
  value: z.string().max(4000).optional(),
  pageId: z.string().min(1).optional(),
  frame: z.string().min(1).max(500).optional()
});

/**
 * Private control API used by the API service. It is only reachable on the
 * internal Docker network and is never published to the host.
 */
export async function buildControlServer(
  config: WorkerConfig,
  sessions: SessionManager,
  log: Logger
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SessionNotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof SessionLimitError) {
      return reply.code(429).send({ error: error.message });
    }
    request.log.error({ err: error }, "Worker control API error");
    return reply.code(500).send({ error: error.message });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "worker",
    sessions: sessions.count
  }));

  app.get("/ready", async () => ({ status: "ready", sessions: sessions.count }));

  app.post("/sessions", async (request, reply) => {
    const parsed = CreateSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid session payload" });
    }
    const session = await sessions.create(parsed.data);
    return reply.code(201).send(describe(session));
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request) =>
    describe(sessions.get(request.params.id))
  );

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request) => {
    await sessions.close(request.params.id);
    return { closed: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/recording", async (request, reply) => {
    const parsed = ToggleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "enabled must be a boolean" });
    const session = sessions.get(request.params.id);
    await session.setRecording(parsed.data.enabled);
    return describe(session);
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/highlight", async (request, reply) => {
    const parsed = ToggleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "enabled must be a boolean" });
    const session = sessions.get(request.params.id);
    await session.setHighlight(parsed.data.enabled);
    return describe(session);
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/recording", async (request) => {
    const session = sessions.get(request.params.id);
    const recording = session.buildRecording();
    return {
      actions: recording.actions,
      steps: recording.steps,
      // Only the names leave the worker: values are returned to the API
      // separately, encrypted before storage.
      credentials: recording.credentials.map((c) => ({ name: c.name })),
      credentialValues: recording.credentials,
      skipped: recording.skipped
    };
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id/recording", async (request) => {
    const session = sessions.get(request.params.id);
    session.clearRecording();
    return describe(session);
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/wait", async (request, reply) => {
    const parsed = WaitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "ms must be a number" });
    const session = sessions.get(request.params.id);
    session.addManualWait(parsed.data.ms);
    return describe(session);
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/navigate", async (request, reply) => {
    const parsed = NavigateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "url must be a valid URL" });
    const session = sessions.get(request.params.id);
    await session.navigate(parsed.data.url);
    return describe(session);
  });

  app.get<{ Params: { id: string }; Querystring: { selector?: string; pageId?: string; frame?: string } }>(
    "/sessions/:id/element",
    async (request, reply) => {
      const selector = request.query.selector;
      if (!selector) return reply.code(400).send({ error: "selector is required" });
      const session = sessions.get(request.params.id);
      const info = await session.describeElement(selector, {
        pageId: request.query.pageId,
        frame: request.query.frame
      });
      if (!info) return reply.code(404).send({ error: "No element matches that selector" });
      return info;
    }
  );

  app.post<{ Params: { id: string } }>("/sessions/:id/interact", async (request, reply) => {
    const parsed = InteractSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid interaction payload" });
    }
    const session = sessions.get(request.params.id);
    await session.interact(parsed.data);
    return describe(session);
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/switch-page", async (request, reply) => {
    const body = z.object({ pageId: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "pageId is required" });
    const session = sessions.get(request.params.id);
    if (!session.setActivePage(body.data.pageId)) {
      return reply.code(404).send({ error: `Page ${body.data.pageId} is not open` });
    }
    return describe(session);
  });

  log.info("Worker control API configured");
  return app;
}

function describe(session: {
  sessionId: string;
  userId: string;
  state: string;
  slot: { vncPort: number };
  startUrl: string;
  recording: boolean;
  highlight: boolean;
  currentUrl: string | null;
  error: string | null;
  expiresAt: Date;
  listPages: () => Array<{ pageId: string; url: string; active: boolean }>;
}) {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    state: session.state,
    vncPort: session.slot.vncPort,
    startUrl: session.startUrl,
    recording: session.recording,
    highlight: session.highlight,
    currentUrl: session.currentUrl,
    pages: session.listPages(),
    error: session.error,
    expiresAt: session.expiresAt.toISOString()
  };
}
