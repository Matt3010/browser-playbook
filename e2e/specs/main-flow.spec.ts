import { test, expect, type Page } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
  getTestWebState,
  resetTestWeb
} from "../helpers/app-client";

const WIZARD = {
  name: "Mario Rossi",
  email: "mario@example.com",
  plan: "pro",
  notes: "Nota inserita dal test end-to-end"
};

async function loginThroughUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(SEED_EMAIL);
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

/** Reads the live session id the recorder page is attached to. */
async function sessionIdOf(page: Page): Promise<string> {
  const value = await page.getByTestId("session-state").getAttribute("data-session-id");
  if (!value) throw new Error("the recorder page has no active session");
  return value;
}

test.describe("main end-to-end flow", () => {
  test("records a login and a multi-page form on test-web, saves it, runs it and verifies the data", async ({
    page
  }) => {
    await resetTestWeb();

    // The API client shares the credentials of the seeded user; it acts as the
    // human interacting with the remote browser shown over noVNC.
    const client = new AppClient();
    await client.login();

    // ---- 2. log into the application ----
    await loginThroughUi(page);

    // ---- 3. create the workflow ----
    const workflowName = `Login e wizard ${Date.now()}`;
    await page.getByTestId("nav-workflows").click();
    await page.getByTestId("new-workflow").click();
    await page.getByLabel("Nome").fill(workflowName);
    await page.getByLabel("URL iniziale").fill(`${TEST_WEB_INTERNAL_URL}/login`);
    await page.getByRole("button", { name: "Crea workflow" }).click();

    await expect(page.getByTestId("recorder-page")).toBeVisible();
    await expect(page.getByTestId("workflow-name")).toHaveText(workflowName);
    await expect(page.getByTestId("workflow-status")).toHaveText("draft");

    // ---- 4. start the remote browser ----
    await page.getByTestId("start-browser").click();
    await expect(page.getByTestId("session-state")).toContainText("ready", { timeout: 90_000 });

    // ---- 5. noVNC is reachable and streaming ----
    await expect(page.getByTestId("vnc-state")).toContainText("connected", { timeout: 60_000 });

    const sessionId = await sessionIdOf(page);

    // ---- 6/7. start recording on test-web/login and enter the credentials ----
    await page.getByTestId("record").click();
    await expect(page.getByTestId("recording-state")).toContainText("attiva");

    await client.interact(sessionId, { kind: "fill", selector: "#email", value: SEED_EMAIL });
    await client.interact(sessionId, { kind: "fill", selector: "#password", value: SEED_PASSWORD });

    // ---- 8. submit the login ----
    await client.interact(sessionId, { kind: "click", selector: "button[type=submit]" });

    // ---- 9. the dashboard is reached ----
    await expect
      .poll(async () => (await client.getSession(sessionId)).currentUrl, { timeout: 60_000 })
      .toContain("/dashboard");

    // ---- 10. open the multi-page form ----
    await client.interact(sessionId, { kind: "click", selector: "[data-testid=link-wizard]" });
    await expect
      .poll(async () => (await client.getSession(sessionId)).currentUrl, { timeout: 60_000 })
      .toContain("/wizard/step-1");

    // ---- 11. fill step 1 ----
    await client.interact(sessionId, { kind: "fill", selector: "#fullname", value: WIZARD.name });
    await client.interact(sessionId, { kind: "fill", selector: "#wizard-email", value: WIZARD.email });

    // ---- 12. move to step 2 ----
    await client.interact(sessionId, { kind: "click", selector: "button[type=submit]" });
    await expect
      .poll(async () => (await client.getSession(sessionId)).currentUrl, { timeout: 60_000 })
      .toContain("/wizard/step-2");

    // ---- 13. select, checkbox and textarea ----
    await client.interact(sessionId, { kind: "select", selector: "#plan", value: WIZARD.plan });
    await client.interact(sessionId, { kind: "check", selector: "#newsletter" });
    await client.interact(sessionId, { kind: "fill", selector: "#notes", value: WIZARD.notes });

    // ---- 14. complete the form ----
    await client.interact(sessionId, { kind: "click", selector: "button[type=submit]" });
    await expect
      .poll(async () => (await client.getSession(sessionId)).currentUrl, { timeout: 60_000 })
      .toContain("/wizard/complete");

    // The recorder must have produced the whole ordered step list.
    await expect
      .poll(async () => (await client.getRecording(sessionId)).steps.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(9);

    await page.getByTestId("stop-recording").click();
    await expect(page.getByTestId("recording-state")).toContainText("ferma");

    // Stopping pulls the final action stream, so the editor and the worker agree.
    const recording = await client.getRecording(sessionId);
    await expect
      .poll(async () => page.getByTestId("step-list").locator("li").count(), { timeout: 30_000 })
      .toBe(recording.steps.length);
    const types = recording.steps.map((s) => s.type);
    expect(types[0]).toBe("goto");
    expect(types).toContain("fill");
    expect(types).toContain("click");
    expect(types).toContain("select");
    expect(types).toContain("check");
    expect(recording.skipped).toBe(0);

    // The password became a credential reference, never a literal.
    const passwordStep = recording.steps.find((s) => s.value === "{{credentials.password}}");
    expect(passwordStep, "the password step must reference a credential").toBeTruthy();
    expect(JSON.stringify(recording.steps)).not.toContain(SEED_PASSWORD);
    expect(recording.credentials.map((c) => c.name)).toContain("password");

    // The UI shows the recorded steps in order.
    await expect(page.getByTestId("step-list")).toBeVisible();
    await expect(page.getByTestId("step-type-0")).toHaveText("goto");

    // ---- 15. save the workflow ----
    await page.getByTestId("save-steps").click();
    await expect(page.getByTestId("workflow-status")).toHaveText("ready", { timeout: 30_000 });

    const savedWorkflow = await client.getWorkflow(
      page.url().split("/workflows/")[1].split(/[?#]/)[0]
    );
    expect(savedWorkflow.steps.length).toBe(recording.steps.length);
    expect(JSON.stringify(savedWorkflow.steps)).not.toContain(SEED_PASSWORD);

    // The captured secret was stored, encrypted and unreadable through the API.
    const credentials = await client.listCredentials();
    const stored = credentials.find((c) => c.name === "password");
    expect(stored).toBeTruthy();
    expect(stored!.kind).toBe("secret");
    expect(stored!.value).toBeNull();

    await page.getByTestId("close-session").click();

    // ---- 16. run it immediately ----
    const submissionsBefore = (await getTestWebState()).wizardSubmissions.length;

    await page.getByTestId("run-now").click();
    await expect(page.getByTestId("execution-detail")).toBeVisible({ timeout: 30_000 });
    const executionId = page.url().split("/executions/")[1];

    // ---- 18. the execution completes ----
    const execution = await client.waitForExecution(executionId);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
    expect(execution.errorMessage).toBeNull();
    expect(execution.currentUrl).toContain("/wizard/complete");
    expect(execution.durationMs ?? 0).toBeGreaterThan(0);

    await expect(page.getByTestId("execution-status")).toHaveText("completed", { timeout: 30_000 });

    // Per-step logs with durations were persisted.
    const logMessages = (execution.logs ?? []).map((l) => l.message).join("\n");
    expect(logMessages).toMatch(/Step 1\/\d+/);
    expect(logMessages).toMatch(/completed in \d+ ms/);
    expect(logMessages).not.toContain(SEED_PASSWORD);

    // ---- 17. test-web received the replayed data ----
    const state = await getTestWebState();
    expect(state.wizardSubmissions.length).toBe(submissionsBefore + 1);
    const submission = state.wizardSubmissions[state.wizardSubmissions.length - 1];
    expect(submission).toMatchObject({
      name: WIZARD.name,
      email: WIZARD.email,
      plan: WIZARD.plan,
      newsletter: true,
      notes: WIZARD.notes
    });

    // ---- 19. a success notification was created ----
    await expect
      .poll(async () => (await client.notifications()).items.map((n) => n.type), {
        timeout: 30_000
      })
      .toContain("workflow_completed");

    await page.getByTestId("nav-notifications").click();
    await expect(page.getByTestId("notification-workflow_completed").first()).toBeVisible();
    await expect(page.getByTestId("notification-workflow_completed").first()).toContainText(
      "completato"
    );
  });
});
