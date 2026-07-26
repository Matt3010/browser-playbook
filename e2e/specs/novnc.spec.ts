import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { AppClient, APP_BASE_URL, TEST_WEB_INTERNAL_URL } from "../helpers/app-client";

/** Opens the noVNC WebSocket and resolves with the first frame received. */
function readFirstFrame(
  url: string,
  cookie: string,
  timeoutMs = 20_000
): Promise<{ kind: "data"; payload: string } | { kind: "closed"; code: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ["binary"], { headers: { cookie } });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no frame received in time"));
    }, timeoutMs);

    socket.on("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve({ kind: "data", payload: Buffer.from(data as Buffer).toString("latin1").trim() });
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve({ kind: "closed", code });
    });
    socket.on("error", () => {
      /* close handler reports the outcome */
    });
  });
}

test.describe("noVNC stream", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    client = new AppClient();
    await client.login();
  });

  test("streams the remote browser through the authenticated proxy", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    expect(session.state).toBe("ready");
    expect(session.vncPath).toContain(`/api/sessions/${session.sessionId}/vnc`);
    // The internal VNC port must never be disclosed to the client.
    expect(JSON.stringify(session)).not.toContain("vncPort");

    try {
      const url = `${APP_BASE_URL.replace(/^http/, "ws")}${session.vncPath}`;
      const frame = await readFirstFrame(url, client.sessionCookie);
      expect(frame.kind).toBe("data");
      // x11vnc greets every client with the RFB protocol version.
      expect((frame as { payload: string }).payload).toMatch(/^RFB \d{3}\.\d{3}$/);
    } finally {
      await client.closeSession(session.sessionId);
    }
  });

  test("refuses the stream without a token", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    try {
      const url = `${APP_BASE_URL.replace(/^http/, "ws")}/api/sessions/${session.sessionId}/vnc`;
      const frame = await readFirstFrame(url, client.sessionCookie);
      expect(frame.kind).toBe("closed");
      expect((frame as { code: number }).code).toBe(4401);
    } finally {
      await client.closeSession(session.sessionId);
    }
  });

  test("refuses the stream without an application session", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    try {
      const url = `${APP_BASE_URL.replace(/^http/, "ws")}${session.vncPath}`;
      const frame = await readFirstFrame(url, "");
      expect(frame.kind).toBe("closed");
      expect((frame as { code: number }).code).toBe(4401);
    } finally {
      await client.closeSession(session.sessionId);
    }
  });

  test("refuses a token issued for a different session", async () => {
    const first = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    const second = await client.createSession(`${TEST_WEB_INTERNAL_URL}/dashboard`);
    try {
      const url =
        `${APP_BASE_URL.replace(/^http/, "ws")}/api/sessions/${second.sessionId}/vnc` +
        `?token=${encodeURIComponent(first.token)}`;
      const frame = await readFirstFrame(url, client.sessionCookie);
      expect(frame.kind).toBe("closed");
      expect((frame as { code: number }).code).toBe(4403);
    } finally {
      await client.closeSession(first.sessionId);
      await client.closeSession(second.sessionId);
    }
  });

  test("the recorder page shows the browser stream", async ({ page }) => {
    // Log in through the UI so the browser holds the session cookie.
    await page.goto("/login");
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("TestPassword123!");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.getByTestId("dashboard")).toBeVisible();

    const workflow = await client.createWorkflow(
      `noVNC UI ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/login`
    );
    await page.goto(`/workflows/${workflow.id}`);
    await page.getByTestId("start-browser").click();

    await expect(page.getByTestId("session-state")).toContainText("ready", { timeout: 90_000 });
    // The noVNC client reports a live connection once the RFB session is up.
    await expect(page.getByTestId("vnc-state")).toContainText("connected", { timeout: 60_000 });

    await page.getByTestId("close-session").click();
    await expect(page.getByTestId("session-state")).toContainText("non avviata", {
      timeout: 30_000
    });
  });
});
