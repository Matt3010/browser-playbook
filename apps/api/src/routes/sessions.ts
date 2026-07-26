import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import WebSocket from "ws";
import {
  assertSafeTargetUrl,
  encryptSecret,
  signSessionToken,
  verifySessionToken,
  verifyAuthToken
} from "@app/shared";
import { requireAuth, currentUser, SESSION_COOKIE } from "../auth";
import { WorkerHttpError, type WorkerSessionInfo } from "../worker-client";

/** Shortest session lifetime a client may ask for. */
const MIN_SESSION_TIMEOUT_MS = 10_000;

const CreateSessionSchema = z.object({
  startUrl: z.string().min(1).max(2000),
  workflowId: z.string().uuid().optional(),
  /**
   * Optional shorter lifetime for this session. It is clamped to the configured
   * maximum, so a client can only ask for less, never more.
   */
  timeoutMs: z.coerce.number().int().min(MIN_SESSION_TIMEOUT_MS).optional()
});

const ToggleSchema = z.object({ enabled: z.boolean() });
const NavigateSchema = z.object({ url: z.string().min(1).max(2000) });
const InteractSchema = z.object({
  kind: z.enum(["click", "fill", "select", "check", "uncheck", "press"]),
  selector: z.string().min(1).max(500).optional(),
  value: z.string().max(4000).optional(),
  pageId: z.string().min(1).optional(),
  frame: z.string().min(1).max(500).optional()
});

/**
 * RFC 6455 reserves some close codes (1004, 1005, 1006, 1015): they describe a
 * connection state and must never be sent on the wire. Forwarding one verbatim
 * makes `ws` throw, so anything not sendable becomes a generic 1011.
 */
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

function sendableCloseCode(code: number): number {
  if (RESERVED_CLOSE_CODES.has(code)) return 1011;
  if (code >= 1000 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const urlSafetyOptions = {
    allowPrivateTargets: app.config.allowPrivateTargets,
    allowedHosts: app.config.allowedTargetHosts
  };

  /** Worker host used to reach the per-session websockify port. */
  const workerHost = new URL(app.config.workerUrl).hostname;

  async function loadOwnedSession(userId: string, sessionId: string): Promise<WorkerSessionInfo> {
    const info = await app.worker.getSession(sessionId);
    if (info.userId !== userId) {
      // Report as missing: never confirm that another user's session exists.
      throw new WorkerHttpError("Session not found", 404);
    }
    return info;
  }

  // ---- authenticated JSON endpoints ----------------------------------------

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireAuth);

    scoped.post("/", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = CreateSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "startUrl is required" });
      }
      try {
        assertSafeTargetUrl(parsed.data.startUrl, urlSafetyOptions);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const sessionId = randomUUID();
      const timeoutMs = Math.min(
        parsed.data.timeoutMs ?? app.config.browserSessionTimeoutMs,
        app.config.browserSessionTimeoutMs
      );
      try {
        const info = await app.worker.createSession({
          sessionId,
          userId,
          startUrl: parsed.data.startUrl,
          timeoutMs
        });
        const token = signSessionToken(
          { sessionId, userId, scope: "vnc" },
          app.config.jwtSecret,
          app.config.sessionTokenTtlSeconds
        );
        return reply.code(201).send({
          sessionId: info.sessionId,
          state: info.state,
          startUrl: info.startUrl,
          recording: info.recording,
          highlight: info.highlight,
          expiresAt: info.expiresAt,
          token,
          // Path the frontend opens with noVNC; the VNC port itself is never exposed.
          vncPath: `/api/sessions/${sessionId}/vnc?token=${encodeURIComponent(token)}`
        });
      } catch (err) {
        if (err instanceof WorkerHttpError) {
          return reply.code(err.statusCode === 404 ? 503 : err.statusCode).send({ error: err.message });
        }
        app.log.error({ err }, "Failed to create browser session");
        return reply.code(503).send({ error: "Browser worker unavailable" });
      }
    });

    /**
     * Lists the caller's live browser sessions, so an abandoned one can be found
     * and closed instead of waiting for it to be reclaimed.
     */
    scoped.get("/", async (request, reply) => {
      const { userId } = currentUser(request);
      try {
        const all = await app.worker.listSessions();
        return all
          .filter((session) => session.userId === userId)
          .map((session) => ({
            sessionId: session.sessionId,
            state: session.state,
            startUrl: session.startUrl,
            currentUrl: session.currentUrl,
            recording: session.recording,
            idleMs: session.idleMs,
            expiresAt: session.expiresAt
          }));
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    scoped.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
      const { userId } = currentUser(request);
      try {
        const info = await loadOwnedSession(userId, request.params.id);
        return {
          sessionId: info.sessionId,
          state: info.state,
          startUrl: info.startUrl,
          currentUrl: info.currentUrl ?? null,
          recording: info.recording,
          highlight: info.highlight,
          armedFinal: info.armedFinal ?? false,
          pages: info.pages ?? [],
          error: info.error ?? null,
          expiresAt: info.expiresAt
        };
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status === 404 ? 404 : status).send({ error: (err as Error).message });
      }
    });

    scoped.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
      const { userId } = currentUser(request);
      try {
        await loadOwnedSession(userId, request.params.id);
        const result = await app.worker.closeSession(request.params.id);
        return result;
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    scoped.post<{ Params: { id: string } }>("/:id/recording", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = ToggleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "enabled must be a boolean" });
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.setRecording(request.params.id, parsed.data.enabled);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    /**
     * Arms the capture of a closing action: the next interaction in the page is
     * recorded and suppressed, so a destructive final step is never performed
     * while recording.
     */
    scoped.post<{ Params: { id: string } }>("/:id/arm-final", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = ToggleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "enabled must be a boolean" });
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.setArmedFinal(request.params.id, parsed.data.enabled);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    scoped.post<{ Params: { id: string } }>("/:id/highlight", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = ToggleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "enabled must be a boolean" });
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.setHighlight(request.params.id, parsed.data.enabled);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    scoped.get<{ Params: { id: string } }>("/:id/recording", async (request, reply) => {
      const { userId } = currentUser(request);
      try {
        await loadOwnedSession(userId, request.params.id);
        const recording = await app.worker.getRecording(request.params.id);
        // Captured secret values stay on the server: the client only learns the
        // credential names that the steps reference.
        return {
          actions: recording.actions,
          steps: recording.steps,
          credentials: recording.credentials,
          skipped: recording.skipped
        };
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    /**
     * Persists the credentials captured during recording, encrypted. Called
     * before saving the steps so that {{credentials.x}} references resolve.
     */
    scoped.post<{ Params: { id: string } }>("/:id/credentials", async (request, reply) => {
      const { userId } = currentUser(request);
      try {
        await loadOwnedSession(userId, request.params.id);
        const recording = await app.worker.getRecording(request.params.id);
        const values = recording.credentialValues ?? [];

        for (const entry of values) {
          await app.prisma.credential.upsert({
            where: { userId_name: { userId, name: entry.name } },
            create: {
              userId,
              name: entry.name,
              kind: "secret",
              encryptedValue: encryptSecret(entry.value, app.config.credentialsEncKey)
            },
            update: {
              kind: "secret",
              encryptedValue: encryptSecret(entry.value, app.config.credentialsEncKey)
            }
          });
        }
        return { saved: values.map((v) => v.name) };
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    /** Describes one element of the live page, for the "selected element" panel. */
    scoped.get<{
      Params: { id: string };
      Querystring: { selector?: string; pageId?: string; frame?: string };
    }>("/:id/element", async (request, reply) => {
      const { userId } = currentUser(request);
      if (!request.query.selector) {
        return reply.code(400).send({ error: "selector is required" });
      }
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.describeElement(request.params.id, {
          selector: request.query.selector,
          pageId: request.query.pageId,
          frame: request.query.frame
        });
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    /**
     * Performs an input action on the live session. This complements pointing
     * and typing over noVNC: the browser generates the same real input events,
     * so the recorder captures the action either way.
     */
    scoped.post<{ Params: { id: string } }>("/:id/interact", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = InteractSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid interaction payload" });
      }
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.interact(request.params.id, parsed.data);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    scoped.post<{ Params: { id: string } }>("/:id/switch-page", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = z.object({ pageId: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "pageId is required" });
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.switchPage(request.params.id, parsed.data.pageId);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    /** Records an explicit manual wait into the action stream. */
    scoped.post<{ Params: { id: string } }>("/:id/wait", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = z.object({ ms: z.coerce.number().int().min(0).max(120_000) }).safeParse(
        request.body
      );
      if (!parsed.success) return reply.code(400).send({ error: "ms must be a number" });
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.addWait(request.params.id, parsed.data.ms);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });

    scoped.post<{ Params: { id: string } }>("/:id/navigate", async (request, reply) => {
      const { userId } = currentUser(request);
      const parsed = NavigateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "url is required" });
      try {
        assertSafeTargetUrl(parsed.data.url, urlSafetyOptions);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        await loadOwnedSession(userId, request.params.id);
        return await app.worker.navigate(request.params.id, parsed.data.url);
      } catch (err) {
        const status = err instanceof WorkerHttpError ? err.statusCode : 503;
        return reply.code(status).send({ error: (err as Error).message });
      }
    });
  });

  // ---- noVNC WebSocket proxy ----------------------------------------------

  /**
   * Bridges the browser's noVNC client to the worker's per-session websockify.
   * Requires BOTH a valid app session cookie and a short-lived token scoped to
   * this exact session, so the VNC stream of one session can never be opened
   * from another session or another user.
   */
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    "/:id/vnc",
    { websocket: true },
    async (socket, request) => {
      const closeWith = (code: number, reason: string) => {
        app.log.warn({ sessionId: request.params.id, reason }, "Rejected noVNC connection");
        socket.close(code, reason);
      };

      const cookie = request.cookies[SESSION_COOKIE];
      if (!cookie) return closeWith(4401, "Not authenticated");

      let userId: string;
      try {
        userId = verifyAuthToken(cookie, app.config.jwtSecret).userId;
      } catch {
        return closeWith(4401, "Invalid session");
      }

      const token = request.query.token;
      if (!token) return closeWith(4401, "Missing VNC token");

      let payload;
      try {
        payload = verifySessionToken(token, app.config.jwtSecret);
      } catch {
        return closeWith(4401, "Invalid or expired VNC token");
      }
      if (payload.scope !== "vnc") return closeWith(4403, "Wrong token scope");
      if (payload.sessionId !== request.params.id) return closeWith(4403, "Token/session mismatch");
      if (payload.userId !== userId) return closeWith(4403, "Token belongs to another user");

      let info: WorkerSessionInfo;
      try {
        info = await app.worker.getSession(request.params.id);
      } catch {
        return closeWith(4404, "Session not found");
      }
      if (info.userId !== userId) return closeWith(4403, "Session belongs to another user");
      if (info.state === "closed" || info.state === "error") {
        return closeWith(4410, `Session is ${info.state}`);
      }

      const target = `ws://${workerHost}:${info.vncPort}/`;
      const upstream = new WebSocket(target, ["binary"], { perMessageDeflate: false });
      const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

      const closeClient = (code: number, reason: string) => {
        try {
          if (socket.readyState === WebSocket.OPEN) socket.close(sendableCloseCode(code), reason);
        } catch (err) {
          app.log.debug({ err }, "Could not close the noVNC client socket");
        }
      };
      const closeUpstream = () => {
        try {
          if (
            upstream.readyState === WebSocket.OPEN ||
            upstream.readyState === WebSocket.CONNECTING
          ) {
            upstream.close();
          }
        } catch (err) {
          app.log.debug({ err }, "Could not close the noVNC upstream socket");
        }
      };

      upstream.on("open", () => {
        for (const frame of pending) {
          try {
            upstream.send(frame.data as Buffer, { binary: frame.isBinary });
          } catch (err) {
            app.log.debug({ err }, "Dropped a buffered noVNC frame");
          }
        }
        pending.length = 0;
      });
      upstream.on("message", (data, isBinary) => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(data as Buffer, { binary: isBinary });
          }
        } catch (err) {
          app.log.debug({ err }, "Dropped a noVNC frame towards the client");
        }
      });
      upstream.on("close", (code, reason) => {
        closeClient(code, reason.toString().slice(0, 100));
      });
      upstream.on("error", (err) => {
        app.log.warn({ err, target }, "noVNC upstream error");
        closeClient(1011, "Upstream error");
      });

      socket.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          try {
            upstream.send(data as Buffer, { binary: isBinary });
          } catch (err) {
            app.log.debug({ err }, "Dropped a noVNC frame towards the worker");
          }
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          pending.push({ data, isBinary });
        }
      });
      socket.on("close", closeUpstream);
      socket.on("error", closeUpstream);
    }
  );
}
