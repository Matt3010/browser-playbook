import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { AppClient, APP_BASE_URL, TEST_WEB_INTERNAL_URL } from "../helpers/app-client";

function probeStream(url: string, cookie: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, ["binary"], { headers: { cookie } });
    const timer = setTimeout(() => {
      socket.close();
      resolve("timeout");
    }, timeoutMs);
    socket.on("message", () => {
      clearTimeout(timer);
      socket.close();
      resolve("data");
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve(`closed:${code}`);
    });
    socket.on("error", () => {
      /* the close handler reports the outcome */
    });
  });
}

test.describe("browser session isolation", () => {
  test("two sessions do not share cookies or localStorage", async () => {
    const client = new AppClient();
    await client.login();

    const first = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    const second = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);

    try {
      // Log in only inside the first session.
      await client.interact(first.sessionId, {
        kind: "fill",
        selector: "#email",
        value: "test@example.com"
      });
      await client.interact(first.sessionId, {
        kind: "fill",
        selector: "#password",
        value: "TestPassword123!"
      });
      await client.interact(first.sessionId, { kind: "click", selector: "button[type=submit]" });

      await expect
        .poll(async () => (await client.getSession(first.sessionId)).currentUrl, {
          timeout: 45_000
        })
        .toContain("/dashboard");

      // The second session must still be anonymous: navigating to the
      // protected page bounces it back to the login form.
      await client.navigateSession(second.sessionId, `${TEST_WEB_INTERNAL_URL}/dashboard`);
      await expect
        .poll(async () => (await client.getSession(second.sessionId)).currentUrl, {
          timeout: 45_000
        })
        .toContain("/login");

      // The first session keeps its authenticated state.
      await client.navigateSession(first.sessionId, `${TEST_WEB_INTERNAL_URL}/dashboard`);
      await expect
        .poll(async () => (await client.getSession(first.sessionId)).currentUrl, {
          timeout: 45_000
        })
        .toContain("/dashboard");
    } finally {
      await client.closeSession(first.sessionId).catch(() => undefined);
      await client.closeSession(second.sessionId).catch(() => undefined);
    }
  });

  test("closing one session does not terminate the other", async () => {
    const client = new AppClient();
    await client.login();

    const first = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    const second = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);

    try {
      await client.closeSession(first.sessionId);

      const firstAfter = await client.request("GET", `/api/sessions/${first.sessionId}`);
      expect(firstAfter.status).toBe(404);

      const secondAfter = await client.getSession(second.sessionId);
      expect(secondAfter.state).toBe("ready");

      // The surviving session is still usable.
      await client.interact(second.sessionId, {
        kind: "fill",
        selector: "#text-input",
        value: "ancora viva"
      });
    } finally {
      await client.closeSession(second.sessionId).catch(() => undefined);
    }
  });

  test("a user cannot see another user's session or its noVNC stream", async () => {
    const owner = new AppClient();
    await owner.login();

    const intruder = new AppClient();
    await intruder.register(`intruder-${Date.now()}@example.com`);

    const session = await owner.createSession(`${TEST_WEB_INTERNAL_URL}/login`);

    try {
      // Every session endpoint reports the session as missing for the intruder.
      for (const [method, path, body] of [
        ["GET", `/api/sessions/${session.sessionId}`, undefined],
        ["DELETE", `/api/sessions/${session.sessionId}`, undefined],
        ["GET", `/api/sessions/${session.sessionId}/recording`, undefined],
        ["POST", `/api/sessions/${session.sessionId}/recording`, { enabled: true }],
        ["POST", `/api/sessions/${session.sessionId}/interact`, { kind: "click", selector: "body" }]
      ] as const) {
        const response = await intruder.request(method, path, body);
        expect(response.status, `${method} ${path}`).toBe(404);
      }

      // Even holding the owner's token, the intruder's app session is refused.
      const url =
        `${APP_BASE_URL.replace(/^http/, "ws")}/api/sessions/${session.sessionId}/vnc` +
        `?token=${encodeURIComponent(session.token)}`;
      const result = await probeStream(url, intruder.sessionCookie);
      expect(result).toBe("closed:4403");

      // The owner's session survived all of it.
      expect((await owner.getSession(session.sessionId)).state).toBe("ready");
    } finally {
      await owner.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("a session closes itself when its maximum lifetime expires", async () => {
    const client = new AppClient();
    await client.login();

    // The shortest lifetime the API accepts, so the timeout is observable.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`, 10_000);
    expect(session.state).toBe("ready");
    expect(new Date(session.expiresAt as string).getTime()).toBeLessThan(Date.now() + 20_000);

    // Once the lifetime elapses the worker tears the session down on its own and
    // the session is no longer known.
    await expect
      .poll(
        async () => (await client.request("GET", `/api/sessions/${session.sessionId}`)).status,
        { timeout: 90_000, intervals: [2000] }
      )
      .toBe(404);

    // A second session can still be created, so the display and port were freed.
    const next = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    expect(next.state).toBe("ready");
    await client.closeSession(next.sessionId);
  });

  test("credentials are scoped to their owner", async () => {
    const owner = new AppClient();
    await owner.login();
    await owner.saveCredential("isolation_secret", "valore-segreto", "secret");

    const other = new AppClient();
    await other.register(`other-${Date.now()}@example.com`);

    const theirs = await other.listCredentials();
    expect(theirs.find((c) => c.name === "isolation_secret")).toBeUndefined();
  });
});
