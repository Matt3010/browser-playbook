import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword, signAuthToken } from "@app/shared";
import { requireAuth, currentUser, SESSION_COOKIE } from "../auth";

const CredentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200)
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: app.config.nodeEnv === "production" && process.env.COOKIE_SECURE !== "false"
  };

  app.post(
    "/register",
    { config: { rateLimit: { max: app.config.registerRateLimitMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = CredentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid email or password (min 8 characters)" });
      }
      const email = parsed.data.email.toLowerCase();
      const existing = await app.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: "Email already registered" });
      }
      const user = await app.prisma.user.create({
        data: { email, passwordHash: await hashPassword(parsed.data.password) }
      });
      const token = signAuthToken({ userId: user.id, email: user.email }, app.config.jwtSecret);
      return reply
        .setCookie(SESSION_COOKIE, token, cookieOptions)
        .code(201)
        .send({ id: user.id, email: user.email });
    }
  );

  app.post(
    "/login",
    { config: { rateLimit: { max: app.config.loginRateLimitMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = CredentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        // Same generic message as a wrong password: no account enumeration.
        return reply.code(401).send({ error: "Invalid credentials" });
      }
      const email = parsed.data.email.toLowerCase();
      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }
      const token = signAuthToken({ userId: user.id, email: user.email }, app.config.jwtSecret);
      return reply
        .setCookie(SESSION_COOKIE, token, cookieOptions)
        .send({ id: user.id, email: user.email });
    }
  );

  app.post("/logout", async (_request, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
  });

  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const { userId, email } = currentUser(request);
    return { id: userId, email };
  });
}
