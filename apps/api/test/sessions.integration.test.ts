import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifySessionToken } from "@app/shared";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  type TestContext,
  type AuthedUser
} from "./helpers";

let ctx: TestContext;
let user: AuthedUser;
const JWT_SECRET = "integration_test_secret_value";

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.worker.sessions.clear();
  user = await registerUser(ctx.app, "owner@example.com");
});

async function createSession(cookie: string, startUrl = "http://test-web:3001/login") {
  return ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie },
    payload: { startUrl }
  });
}

describe("browser session API", () => {
  it("creates a session and returns a scoped noVNC token", async () => {
    const response = await createSession(user.cookie);
    expect(response.statusCode).toBe(201);

    const body = response.json<{
      sessionId: string;
      state: string;
      token: string;
      vncPath: string;
    }>();
    expect(body.state).toBe("ready");
    expect(body.vncPath).toContain(`/api/sessions/${body.sessionId}/vnc`);

    const payload = verifySessionToken(body.token, JWT_SECRET);
    expect(payload).toMatchObject({
      sessionId: body.sessionId,
      userId: user.id,
      scope: "vnc"
    });
  });

  it("never exposes the internal VNC port to the client", async () => {
    const response = await createSession(user.cookie);
    expect(response.body).not.toContain("vncPort");
    const session = ctx.worker.sessions.get(response.json().sessionId);
    expect(session!.vncPort).toBeGreaterThan(0);
    expect(response.body).not.toContain(String(session!.vncPort));
  });

  it("validates the start URL", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: user.cookie },
      payload: { startUrl: "file:///etc/passwd" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { startUrl: "http://test-web:3001/login" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns the session state", async () => {
    const created = (await createSession(user.cookie)).json();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${created.sessionId}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: created.sessionId,
      state: "ready",
      recording: false
    });
  });

  it("toggles recording and highlighting", async () => {
    const created = (await createSession(user.cookie)).json();

    const recording = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/recording`,
      headers: { cookie: user.cookie },
      payload: { enabled: true }
    });
    expect(recording.statusCode).toBe(200);
    expect(ctx.worker.sessions.get(created.sessionId)!.recording).toBe(true);

    const highlight = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/highlight`,
      headers: { cookie: user.cookie },
      payload: { enabled: false }
    });
    expect(highlight.statusCode).toBe(200);
    expect(ctx.worker.sessions.get(created.sessionId)!.highlight).toBe(false);
  });

  it("rejects a malformed toggle payload", async () => {
    const created = (await createSession(user.cookie)).json();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/recording`,
      headers: { cookie: user.cookie },
      payload: { enabled: "yes" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("validates the navigation URL", async () => {
    const created = (await createSession(user.cookie)).json();
    const bad = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/navigate`,
      headers: { cookie: user.cookie },
      payload: { url: "javascript:alert(1)" }
    });
    expect(bad.statusCode).toBe(400);

    const good = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/navigate`,
      headers: { cookie: user.cookie },
      payload: { url: "http://test-web:3001/dashboard" }
    });
    expect(good.statusCode).toBe(200);
  });

  it("closes a session", async () => {
    const created = (await createSession(user.cookie)).json();
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/sessions/${created.sessionId}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(ctx.worker.sessions.get(created.sessionId)!.state).toBe("closed");
  });

  it("returns 404 for an unknown session", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-4000-8000-000000000000",
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("browser session isolation between users", () => {
  it("hides another user's session on every endpoint", async () => {
    const created = (await createSession(user.cookie)).json();
    const other = await registerUser(ctx.app, "other@example.com");

    for (const [method, url, payload] of [
      ["GET", `/api/sessions/${created.sessionId}`, undefined],
      ["DELETE", `/api/sessions/${created.sessionId}`, undefined],
      ["GET", `/api/sessions/${created.sessionId}/recording`, undefined],
      ["POST", `/api/sessions/${created.sessionId}/recording`, { enabled: true }],
      ["POST", `/api/sessions/${created.sessionId}/highlight`, { enabled: true }],
      [
        "POST",
        `/api/sessions/${created.sessionId}/navigate`,
        { url: "http://test-web:3001/dashboard" }
      ]
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: other.cookie },
        payload
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    // The victim's session is untouched.
    expect(ctx.worker.sessions.get(created.sessionId)!.state).toBe("ready");
  });

  it("issues tokens that are bound to one session and one user", async () => {
    const first = (await createSession(user.cookie)).json();
    const second = (await createSession(user.cookie)).json();
    const firstPayload = verifySessionToken(first.token, JWT_SECRET);
    const secondPayload = verifySessionToken(second.token, JWT_SECRET);

    expect(firstPayload.sessionId).not.toBe(secondPayload.sessionId);
    expect(firstPayload.sessionId).toBe(first.sessionId);
    expect(secondPayload.sessionId).toBe(second.sessionId);

    const other = await registerUser(ctx.app, "other@example.com");
    const theirs = (await createSession(other.cookie)).json();
    expect(verifySessionToken(theirs.token, JWT_SECRET).userId).not.toBe(user.id);
  });

  it("closing one session leaves the other running", async () => {
    const first = (await createSession(user.cookie)).json();
    const second = (await createSession(user.cookie)).json();

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/sessions/${first.sessionId}`,
      headers: { cookie: user.cookie }
    });

    expect(ctx.worker.sessions.get(first.sessionId)!.state).toBe("closed");
    expect(ctx.worker.sessions.get(second.sessionId)!.state).toBe("ready");
  });

  it("gives each session its own VNC port", async () => {
    const first = (await createSession(user.cookie)).json();
    const second = (await createSession(user.cookie)).json();
    const portA = ctx.worker.sessions.get(first.sessionId)!.vncPort;
    const portB = ctx.worker.sessions.get(second.sessionId)!.vncPort;
    expect(portA).not.toBe(portB);
  });
});
