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
  let payload;
  try {
    payload = verifyAuthToken(token, request.server.config.jwtSecret);
  } catch {
    await reply.code(401).send({ error: "Invalid or expired session" });
    return;
  }

  // A valid signature is not enough: the owner may have logged out since, which
  // retires every token issued before that point.
  const user = await request.server.prisma.user.findUnique({
    where: { id: payload.userId },
    select: { tokenVersion: true }
  });
  if (!user || user.tokenVersion !== payload.tokenVersion) {
    await reply.code(401).send({ error: "Session is no longer valid" });
    return;
  }

  request.authUser = { userId: payload.userId, email: payload.email };
}

export function currentUser(request: FastifyRequest): { userId: string; email: string } {
  if (!request.authUser) {
    throw new Error("currentUser called on an unauthenticated request");
  }
  return request.authUser;
}
