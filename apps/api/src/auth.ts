import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAuthToken } from "@app/shared";

export const SESSION_COOKIE = "session";

/**
 * Resolves the owner of a session cookie, or null when the cookie is not one that
 * may still be used.
 *
 * A valid signature is not enough: logging out bumps the owner's token version,
 * which retires every token signed before it, and a user that no longer exists has
 * no sessions. Anything that authenticates a cookie must come through here — the
 * WebSocket upgrade for the noVNC stream once checked the cookie on its own and
 * therefore never learned about revocation.
 */
export async function ownerOfCookie(
  server: FastifyRequest["server"],
  cookie: string | undefined
): Promise<{ userId: string; email: string } | null> {
  if (!cookie) return null;
  let payload;
  try {
    payload = verifyAuthToken(cookie, server.config.jwtSecret);
  } catch {
    return null;
  }
  const user = await server.prisma.user.findUnique({
    where: { id: payload.userId },
    select: { tokenVersion: true }
  });
  if (!user || user.tokenVersion !== payload.tokenVersion) return null;
  return { userId: payload.userId, email: payload.email };
}

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
  const owner = await ownerOfCookie(request.server, token);
  if (!owner) {
    await reply.code(401).send({ error: "Invalid or expired session" });
    return;
  }
  request.authUser = owner;
}

export function currentUser(request: FastifyRequest): { userId: string; email: string } {
  if (!request.authUser) {
    throw new Error("currentUser called on an unauthenticated request");
  }
  return request.authUser;
}
