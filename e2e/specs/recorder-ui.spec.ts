import { test, expect, type Page } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
  getTestWebState,
  resetTestWeb,
  step
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

  test("changing the start URL does not throw away unsaved steps", async ({ page }) => {
    // Steps that are not saved yet exist only in the editor. Starting the browser
    // after changing the start URL reloaded the workflow to pick up the new URL,
    // and the reload replaced the step list with whatever the server had — the
    // recording of the last ten minutes, gone without a word.
    await loginThroughUi(page);

    const workflow = await client.createWorkflow(
      `URL iniziale ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` })
    ]);

    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(1);

    // An unsaved step, the cheapest stand-in for a recording in progress.
    await page.getByTestId("add-wait").click();
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(2);

    await page.getByTestId("start-url").fill(`${TEST_WEB_INTERNAL_URL}/checkout`);
    await page.getByTestId("start-browser").click();
    await expect(page.getByTestId("session-state")).toContainText("ready", { timeout: 90_000 });

    await expect(
      page.getByTestId("step-list").locator("li"),
      "the unsaved step must survive"
    ).toHaveCount(2);

    await page.getByTestId("close-session").click();
  });

  test("goes back to offering a browser when the session is gone", async ({ page }) => {
    // The toolbar is driven by whether a session is held. A session that has
    // ended has to be dropped rather than kept as a dead handle: it used to keep
    // offering "Chiudi browser" for a browser that had already closed, with no
    // way back but a reload.
    await loginThroughUi(page);
    const workflow = await client.createWorkflow(
      `Sessione persa ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    const sessionId = await startSession(page, workflow.id);
    await expect(page.getByTestId("close-session")).toBeVisible();

    // Ended from elsewhere: the idle reaper, a worker restart, another tab.
    await client.closeSession(sessionId);

    await expect(page.getByTestId("start-browser")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("close-session")).toBeHidden();
    await expect(page.getByTestId("live-log")).toContainText("Sessione");
  });

  test("types into the remote browser from the page, and records one step", async ({ page }) => {
    // The stream is a canvas: tapping a field inside it raises no keyboard on a
    // tablet, because there is no field to focus. The text is typed by the
    // server into whatever the remote page has focused, so it arrives as real
    // key events and is recorded exactly like typing on a keyboard.
    await loginThroughUi(page);
    const workflow = await client.createWorkflow(
      `Scrittura remota ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    const sessionId = await startSession(page, workflow.id);

    await page.getByTestId("record").click();
    await expect(page.getByTestId("recording-state")).toContainText("attiva");

    // Focus the remote field the way a finger does: a click inside the stream.
    await client.interact(sessionId, { kind: "click", selector: "#text-input" });

    await page.getByTestId("type-text").fill("scritto dall'app");
    await page.getByTestId("type-send").click();

    // The recorded value is read from the live element by the injected script,
    // so asserting it is asserting that the text reached the remote page.
    await expect
      .poll(
        async () =>
          (await client.getRecording(sessionId)).steps.find((s) => s.type === "fill")?.value,
        { timeout: 30_000 }
      )
      .toBe("scritto dall'app");

    const fills = (await client.getRecording(sessionId)).steps.filter((s) => s.type === "fill");
    expect(fills, "one field, one step").toHaveLength(1);

    // Enter goes to the same place, and is recorded as the press it is.
    await page.getByTestId("type-enter").click();
    await expect
      .poll(async () => (await client.getRecording(sessionId)).steps.some((s) => s.type === "press"))
      .toBe(true);

    await page.getByTestId("close-session").click();
  });

  test("refuses to type when the remote page has nothing focused", async ({ page }) => {
    // Typing into the void is the kind of guess this project refuses everywhere
    // else: the text would land wherever, or nowhere, and the recording would
    // simply be missing a step nobody noticed.
    await loginThroughUi(page);
    const workflow = await client.createWorkflow(
      `Scrittura senza fuoco ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    await startSession(page, workflow.id);

    await page.getByTestId("type-text").fill("nessuno mi aspetta");
    await page.getByTestId("type-send").click();

    // Server messages are in English here, as everywhere else in this product.
    await expect(page.getByTestId("recorder-error")).toContainText("no text field in focus");
    await page.getByTestId("close-session").click();
  });

  test("shows the browser of a run while it is running", async ({ page }) => {
    // The run drives a browser of its own and nobody could look at it: a
    // workflow that stops on an unexpected page could only be read about
    // afterwards, from the logs.
    await loginThroughUi(page);
    const workflow = await client.createWorkflow(
      `Da guardare ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      // Long enough to still be running when the page asks for the stream.
      step({ type: "wait", name: "Attendi", value: "15000" }),
      step({
        type: "click",
        name: "Clicca il bottone",
        selector: { strategy: "id", value: "real-button", fallback: null, pageId: "main", frame: null }
      })
    ]);

    const started = await client.runNow(workflow.id);
    await page.goto(`/executions/${started.id}`);

    await expect(page.getByTestId("execution-stream")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("vnc-connected")).toBeAttached({ timeout: 60_000 });

    // And it goes away with the run: there is nothing left to watch.
    const finished = await client.waitForExecution(started.id);
    expect(finished.status).toBe("completed");
    await expect(page.getByTestId("execution-stream")).toBeHidden({ timeout: 30_000 });
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
