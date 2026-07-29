import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret } from "@app/shared";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  createWorkflow,
  gotoStep,
  fillStep,
  type TestContext,
  type AuthedUser
} from "./helpers";

let ctx: TestContext;
let user: AuthedUser;
const ENC_KEY = "0123456789abcdef0123456789abcdef";
const SECRET = "TestPassword123!";

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  user = await registerUser(ctx.app, "owner@example.com");
});

async function save(kind: "variable" | "secret", name: string, value: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/credentials",
    headers: { cookie: user.cookie },
    payload: { name, value, kind }
  });
}

describe("credentials and variables API", () => {
  it("stores a secret encrypted at rest", async () => {
    const response = await save("secret", "password", SECRET);
    expect(response.statusCode).toBe(201);

    const row = await ctx.prisma.credential.findFirst({ where: { name: "password" } });
    expect(row!.encryptedValue).not.toContain(SECRET);
    expect(decryptSecret(row!.encryptedValue, ENC_KEY)).toBe(SECRET);
  });

  it("never returns a secret value after saving", async () => {
    const created = await save("secret", "password", SECRET);
    expect(created.body).not.toContain(SECRET);
    expect(created.json().value).toBeNull();

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/credentials",
      headers: { cookie: user.cookie }
    });
    expect(list.body).not.toContain(SECRET);
    const items = list.json<Array<{ name: string; kind: string; value: string | null; hasValue: boolean }>>();
    const secret = items.find((i) => i.name === "password");
    expect(secret).toMatchObject({ kind: "secret", value: null, hasValue: true });
  });

  it("returns plain variable values", async () => {
    await save("variable", "customerName", "Acme");
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/credentials",
      headers: { cookie: user.cookie }
    });
    const items = list.json<Array<{ name: string; kind: string; value: string | null }>>();
    expect(items.find((i) => i.name === "customerName")).toMatchObject({
      kind: "variable",
      value: "Acme"
    });
  });

  it("encrypts variables at rest too", async () => {
    await save("variable", "city", "Roma");
    const row = await ctx.prisma.credential.findFirst({ where: { name: "city" } });
    expect(row!.encryptedValue).not.toContain("Roma");
  });

  it("upserts by name instead of duplicating", async () => {
    await save("secret", "password", "first-value");
    await save("secret", "password", "second-value");
    expect(await ctx.prisma.credential.count()).toBe(1);
    const row = await ctx.prisma.credential.findFirst({ where: { name: "password" } });
    expect(decryptSecret(row!.encryptedValue, ENC_KEY)).toBe("second-value");
  });

  it("rejects names that cannot be used in templates", async () => {
    for (const name of ["with space", "with-dash", "with.dot", ""]) {
      const response = await save("secret", name, "x");
      expect(response.statusCode, name).toBe(400);
    }
  });

  it("updates a value without exposing it", async () => {
    const created = await save("secret", "password", SECRET);
    const id = created.json().id;
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/credentials/${id}`,
      headers: { cookie: user.cookie },
      payload: { value: "rotated-value" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().value).toBeNull();
    const row = await ctx.prisma.credential.findUnique({ where: { id } });
    expect(decryptSecret(row!.encryptedValue, ENC_KEY)).toBe("rotated-value");
  });

  it("deletes a credential", async () => {
    const created = await save("secret", "password", SECRET);
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/credentials/${created.json().id}`,
      headers: { cookie: user.cookie }
    });
    // 200 rather than 204: the answer now carries what was deleted, and whether
    // anything switched off still names it.
    expect(response.statusCode).toBe(200);
    expect(await ctx.prisma.credential.count()).toBe(0);
  });

  it("isolates credentials between users", async () => {
    const created = await save("secret", "password", SECRET);
    const other = await registerUser(ctx.app, "other@example.com");

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/credentials",
      headers: { cookie: other.cookie }
    });
    expect(list.json()).toHaveLength(0);

    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await ctx.app.inject({
        method,
        url: `/api/credentials/${created.json().id}`,
        headers: { cookie: other.cookie },
        payload: { value: "hijack" }
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  it("allows two users to use the same credential name independently", async () => {
    await save("secret", "password", "mine");
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/credentials",
      headers: { cookie: other.cookie },
      payload: { name: "password", value: "theirs", kind: "secret" }
    });
    expect(response.statusCode).toBe(201);
    expect(await ctx.prisma.credential.count()).toBe(2);
  });
});

describe("deleting a value a workflow depends on", () => {
  // Nothing looked at who used a credential before removing it. The damage is
  // contained — the run refuses to start rather than breaking halfway — but the user
  // finds out when they try to run the workflow, not when they press delete.
  it("refuses and names the workflows that reference it", async () => {
    const credential = await ctx.app
      .inject({
        method: "POST",
        url: "/api/credentials",
        headers: { cookie: user.cookie },
        payload: { name: "password_apple", kind: "secret", value: "hunter2" }
      })
      .then((r) => r.json<{ id: string }>());

    const workflow = await createWorkflow(ctx.app, user.cookie, "Login Apple");
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: {
        steps: [
          gotoStep("http://test-web:3001/login"),
          fillStep("Password", "{{credentials.password_apple}}")
        ]
      }
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/credentials/${credential.id}`,
      headers: { cookie: user.cookie }
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: string; workflows?: string[] }>();
    expect(body.error).toMatch(/Login Apple/);

    // And it is still there: a refusal that half-deletes would be worse than none.
    const still = await ctx.prisma.credential.findUnique({ where: { id: credential.id } });
    expect(still).not.toBeNull();
  });

  it("deletes one nobody references", async () => {
    const credential = await ctx.app
      .inject({
        method: "POST",
        url: "/api/credentials",
        headers: { cookie: user.cookie },
        payload: { name: "unused_value", kind: "variable", value: "x" }
      })
      .then((r) => r.json<{ id: string }>());

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/credentials/${credential.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().referencedByDisabled).toEqual([]);
  });

  it("ignores a reference made by a disabled step", async () => {
    // A disabled step never runs, so it cannot be broken by the deletion.
    const credential = await ctx.app
      .inject({
        method: "POST",
        url: "/api/credentials",
        headers: { cookie: user.cookie },
        payload: { name: "old_token", kind: "variable", value: "x" }
      })
      .then((r) => r.json<{ id: string }>());

    const workflow = await createWorkflow(ctx.app, user.cookie, "Con step spento");
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: {
        steps: [
          gotoStep("http://test-web:3001/login"),
          { ...fillStep("Password", "{{variables.old_token}}"), enabled: false }
        ]
      }
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/credentials/${credential.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    // Allowed, and said out loud: a step is usually disabled for the afternoon,
    // and re-enabling it later would give a workflow that refuses to start.
    expect(response.json().referencedByDisabled).toHaveLength(1);
  });
});
