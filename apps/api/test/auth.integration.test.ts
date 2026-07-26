import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  TEST_PASSWORD,
  type TestContext
} from "./helpers";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe("auth API", () => {
  it("registers a user and returns a session cookie", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "user@example.com", password: TEST_PASSWORD }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ email: "user@example.com" });
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("never stores or returns the password in clear text", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "user@example.com", password: TEST_PASSWORD }
    });
    expect(response.body).not.toContain(TEST_PASSWORD);
    const stored = await ctx.prisma.user.findUnique({ where: { email: "user@example.com" } });
    expect(stored!.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it("rejects a duplicate email", async () => {
    await registerUser(ctx.app, "dup@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "dup@example.com", password: TEST_PASSWORD }
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects a weak or malformed registration", async () => {
    const short = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@example.com", password: "short" }
    });
    expect(short.statusCode).toBe(400);

    const badEmail = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", password: TEST_PASSWORD }
    });
    expect(badEmail.statusCode).toBe(400);
  });

  it("logs in with the correct password", async () => {
    await registerUser(ctx.app, "login@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "login@example.com", password: TEST_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toContain("session=");
  });

  it("is case-insensitive on the email", async () => {
    await registerUser(ctx.app, "case@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "CASE@Example.com", password: TEST_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a wrong password with a generic message", async () => {
    await registerUser(ctx.app, "wrong@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "wrong@example.com", password: "WrongPassword1!" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid credentials" });
  });

  it("does not reveal whether an account exists", async () => {
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: TEST_PASSWORD }
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: "Invalid credentials" });
  });

  it("returns the current user for an authenticated session", async () => {
    const user = await registerUser(ctx.app, "me@example.com");
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id, email: "me@example.com" });
  });

  it("rejects /me without a session", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a tampered session cookie", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "session=not.a.valid.jwt" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("clears the cookie on logout", async () => {
    const user = await registerUser(ctx.app, "logout@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toMatch(/session=;/);
  });

  it("protects every workflow route", async () => {
    for (const [method, url] of [
      ["GET", "/api/workflows"],
      ["POST", "/api/workflows"],
      ["GET", "/api/credentials"],
      ["GET", "/api/executions"],
      ["GET", "/api/notifications"]
    ] as const) {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("health endpoints", () => {
  it("reports liveness", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
  });

  it("reports readiness with dependency checks", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; checks: Record<string, string> }>();
    expect(body.status).toBe("ready");
    expect(body.checks).toMatchObject({ postgres: "ok", redis: "ok", worker: "ok" });
  });

  it("reports not-ready when a dependency is down", async () => {
    ctx.worker.healthy = false;
    const response = await ctx.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("not-ready");
    ctx.worker.healthy = true;
  });
});

describe("logging out actually ends the session", () => {
  // clearCookie only asks the browser to forget the token. The token itself stayed
  // valid for its full seven days, so anyone holding a copy — and the user's own
  // browser after a back button — could keep using it. A password change did not
  // invalidate it either.
  it("refuses a token that was used to log out", async () => {
    const user = await registerUser(ctx.app, "logout@example.com");

    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: user.cookie }
    });
    expect(before.statusCode).toBe(200);

    const loggedOut = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: user.cookie }
    });
    expect(loggedOut.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: user.cookie }
    });
    expect(after.statusCode, "the old token must no longer work").toBe(401);
  });

  it("does not touch anybody else's session", async () => {
    const one = await registerUser(ctx.app, "one@example.com");
    const two = await registerUser(ctx.app, "two@example.com");

    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: one.cookie }
    });

    const other = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: two.cookie }
    });
    expect(other.statusCode).toBe(200);
  });

  it("lets the same user log in again afterwards", async () => {
    const user = await registerUser(ctx.app, "again@example.com");
    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: user.cookie }
    });

    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "again@example.com", password: "TestPassword123!" }
    });
    expect(login.statusCode).toBe(200);
    const fresh = login.headers["set-cookie"];
    const cookie = Array.isArray(fresh) ? fresh[0]!.split(";")[0]! : String(fresh).split(";")[0]!;

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie }
    });
    expect(me.statusCode).toBe(200);
  });
});
