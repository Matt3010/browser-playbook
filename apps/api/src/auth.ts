import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAuthToken } from "@app/shared";

export const SESSION_COOKIE = "session";

/**
 * preHandler that rejects unauthenticated requests. On success the decoded
 * user is attached to request.authUser for downstream ownership checks.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    await reply.code(401).send({ error: "Not authenticated" });
    return;
  }
  try {
    const payload = verifyAuthToken(token, request.server.config.jwtSecret);
    request.authUser = { userId: payload.userId, email: payload.email };
  } catch {
    await reply.code(401).send({ error: "Invalid or expired session" });
  }
}

export function currentUser(request: FastifyRequest): { userId: string; email: string } {
  if (!request.authUser) {
    throw new Error("currentUser called on an unauthenticated request");
  }
  return request.authUser;
}
