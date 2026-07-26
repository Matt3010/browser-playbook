import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import { AppClient, APP_BASE_URL, TEST_WEB_PUBLIC_URL } from "../helpers/app-client";

const COMPOSE_FILE = process.env.COMPOSE_TEST_FILE ?? "docker-compose.test.yml";

interface ComposeService {
  Service: string;
  Publishers?: Array<{ URL: string; TargetPort: number; PublishedPort: number }>;
}

/**
 * Reads the published-port map of the running test stack. Probing host ports
 * would be unreliable, since unrelated software on the machine may hold them.
 */
function composeServices(): ComposeService[] {
  const raw = execFileSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "ps", "--format", "json"],
    { encoding: "utf8", cwd: process.cwd().replace(/[\\/]e2e$/, "") }
  ).trim();

  // Depending on the Compose version this is either a JSON array or one JSON
  // object per line.
  if (raw.startsWith("[")) return JSON.parse(raw) as ComposeService[];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ComposeService);
}

test.describe("stack health", () => {
  test("the reverse proxy serves the API health endpoint", async () => {
    const response = await fetch(`${APP_BASE_URL}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "api" });
  });

  test("readiness reports Postgres, Redis and the browser worker", async () => {
    const response = await fetch(`${APP_BASE_URL}/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe("ready");
    expect(body.checks).toMatchObject({ postgres: "ok", redis: "ok", worker: "ok" });
  });

  test("the frontend is reachable through the proxy", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("test-web is reachable and healthy", async () => {
    const response = await fetch(`${TEST_WEB_PUBLIC_URL}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "test-web" });
  });

  test("Postgres, Redis, the worker and the VNC ports are not published to the host", () => {
    const services = composeServices();
    expect(services.length).toBeGreaterThan(0);

    const published = new Map<string, number[]>();
    for (const service of services) {
      const ports = (service.Publishers ?? [])
        .filter((p) => p.PublishedPort > 0)
        .map((p) => p.PublishedPort);
      published.set(service.Service, ports);
    }

    // Data stores, the browser worker and the API are internal only.
    for (const service of ["postgres", "redis", "worker", "api", "web"]) {
      expect(published.get(service) ?? [], `${service} must not publish any port`).toEqual([]);
    }

    // Only the reverse proxy is the public entry point; test-web is published
    // solely so the e2e suite can drive the fake application's state.
    expect((published.get("reverse-proxy") ?? []).length).toBeGreaterThan(0);
    for (const [service, ports] of published) {
      if (service === "reverse-proxy" || service === "test-web") continue;
      expect(ports, `${service} must not publish any port`).toEqual([]);
    }
  });

  test("the seeded user can log in and unauthenticated access is refused", async () => {
    const client = new AppClient();
    const anonymous = await client.request("GET", "/api/workflows");
    expect(anonymous.status).toBe(401);

    const me = await client.login();
    expect(me.email).toBe("test@example.com");
    expect((await client.me()).email).toBe("test@example.com");
  });
});
