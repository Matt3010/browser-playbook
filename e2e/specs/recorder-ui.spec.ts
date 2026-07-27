import { test, expect, type Page } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
  getTestWebState,
  resetTestWeb
} from "../helpers/app-client";

/**
 * The recorder page as the user drives it. The other recorder specs talk to the
 * API directly, which is exactly why two defects survived there: what the worker
 * records is right, and the editor still ends up with something else.
 */

async function loginThroughUi(
  page: Page,
  email = SEED_EMAIL,
  password = SEED_PASSWORD
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

/** Reads the live session id the recorder page is attached to. */
async function sessionIdOf(page: Page): Promise<string> {
  const value = await page.getByTestId("session-state").getAttribute("data-session-id");
  if (!value) throw new Error("the recorder page has no active session");
  return value;
}

async function startSession(page: Page, workflowId: string): Promise<string> {
  await page.goto(`/workflows/${workflowId}`);
  await expect(page.getByTestId("recorder-page")).toBeVisible();
  await page.getByTestId("start-browser").click();
  await expect(page.getByTestId("session-state")).toContainText("ready", { timeout: 90_000 });
  return sessionIdOf(page);
}

test.describe("the recorder page keeps the editor in step with the worker", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("the closing action reaches the editor although the capture stops recording", async ({
    page
  }) => {
    await loginThroughUi(page);

    const workflow = await client.createWorkflow(
      `Azione finale dalla UI ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/checkout`
    );
    const sessionId = await startSession(page, workflow.id);

    await page.getByTestId("record").click();
    await expect(page.getByTestId("recording-state")).toContainText("attiva");

    // One ordinary step first, so the closing action is not the only thing in the list.
    await client.interact(sessionId, {
      kind: "fill",
      selector: "#order-note",
      value: "consegna al piano"
    });
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(2, { timeout: 30_000 });

    // Arm from the UI, then click the destructive button in the remote browser.
    await page.getByTestId("arm-final").click();
    await expect(page.getByTestId("arm-final")).toContainText("Armata");
    await client.interact(sessionId, { kind: "click", selector: "#place-order" });

    // Capturing the closing action stops the recording by itself, which disables
    // Stop — the only other thing that pulls the recording into the editor.
    await expect(page.getByTestId("recording-state")).toContainText("ferma", { timeout: 30_000 });
    await expect(page.getByTestId("stop-recording")).toBeDisabled();

    // So the poll has to bring it in, or the user simply loses the action.
    await expect(page.getByTestId("step-final-2")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(3);

    // And Save, which is what the user does next, must persist it as final.
    await page.getByTestId("save-steps").click();
    await expect(page.getByTestId("live-log")).toContainText("step salvati", { timeout: 30_000 });

    const saved = await client.getWorkflow(workflow.id);
    expect(saved.steps).toHaveLength(3);
    expect(saved.steps[2].isFinal).toBe(true);
    expect(
      (await getTestWebState()).orders,
      "the order must not be placed while recording"
    ).toHaveLength(0);

    await page.getByTestId("close-session").click();
  });

  test("running straight after recording stores the secret the steps reference", async ({
    page
  }) => {
    // A user of its own: credentials are per user, so no credential recorded by
    // another spec can make the reference resolve by accident.
    const owner = new AppClient();
    const email = `recorder-ui-${Date.now()}@example.com`;
    await owner.register(email);
    await loginThroughUi(page, email);

    const workflow = await owner.createWorkflow(
      `Esegui subito ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/login`
    );
    const sessionId = await startSession(page, workflow.id);

    await page.getByTestId("record").click();
    await expect(page.getByTestId("recording-state")).toContainText("attiva");

    await owner.interact(sessionId, { kind: "fill", selector: "#email", value: SEED_EMAIL });
    await owner.interact(sessionId, { kind: "fill", selector: "#password", value: SEED_PASSWORD });
    await owner.interact(sessionId, { kind: "click", selector: "button[type=submit]" });
    await expect
      .poll(async () => (await owner.getSession(sessionId)).currentUrl, { timeout: 60_000 })
      .toContain("/dashboard");

    await page.getByTestId("stop-recording").click();
    await expect(page.getByTestId("recording-state")).toContainText("ferma");

    const recorded = await owner.getRecording(sessionId);
    const credentialName = recorded.credentials[0]?.name;
    expect(credentialName, "the password must have been captured as a credential").toBeTruthy();
    expect((await owner.listCredentials()).map((c) => c.name)).not.toContain(credentialName);

    // Straight to "Esegui adesso" without pressing Salva. The button saves the
    // steps it is about to run, so it must save the secret they reference too:
    // saving one without the other queues a run that cannot resolve
    // {{credentials.x}} and fails on the first login attempt.
    await page.getByTestId("run-now").click();
    await expect(page.getByTestId("execution-detail")).toBeVisible({ timeout: 30_000 });

    const executionId = page.url().split("/executions/")[1].split(/[?#]/)[0];
    const execution = await owner.waitForExecution(executionId);
    expect(execution.status, `execution failed: ${execution.errorMessage ?? ""}`).toBe("completed");
    expect(execution.currentUrl).toContain("/dashboard");

    expect((await owner.listCredentials()).map((c) => c.name)).toContain(credentialName);
  });
});
