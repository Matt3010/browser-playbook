import { test, expect } from "@playwright/test";
import {
  AppClient,
  APP_BASE_URL,
  TEST_WEB_INTERNAL_URL,
  configureTestWeb,
  getTestWebState,
  resetTestWeb,
  step,
  uuid
} from "../helpers/app-client";

function gotoStep(url: string) {
  return step({ type: "goto", name: `Vai a ${url}`, value: url });
}

test.describe("stop at the first error", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("a missing element stops the workflow, records the failure and notifies", async () => {
    // The Conferma button is not rendered at all in this configuration.
    await configureTestWeb({ missingElement: true });

    const workflow = await client.createWorkflow(
      `Errore selector ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/errors`
    );

    const failing = step({
      type: "click",
      name: "Clicca Conferma",
      value: null,
      timeoutMs: 4000,
      selector: {
        strategy: "role",
        role: "button",
        name: "Conferma",
        fallback: "#confirm-button",
        pageId: "main",
        frame: null
      }
    });

    // Steps after the failure must never run: they would submit the wizard.
    const afterGoto = gotoStep(`${TEST_WEB_INTERNAL_URL}/wizard/step-1`);
    const afterFill = step({
      type: "fill",
      name: "Inserisci Nome",
      value: "Non deve arrivare",
      selector: { strategy: "label", value: "Nome", fallback: "#fullname", pageId: "main", frame: null }
    });
    const afterClick = step({
      type: "click",
      name: "Clicca Continua",
      selector: {
        strategy: "role",
        role: "button",
        name: "Continua",
        fallback: "button[type=submit]",
        pageId: "main",
        frame: null
      }
    });

    await client.putSteps(workflow.id, [
      gotoStep(`${TEST_WEB_INTERNAL_URL}/errors`),
      failing,
      afterGoto,
      afterFill,
      afterClick
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    // 7. the execution stopped and is marked failed
    expect(execution.status).toBe("failed");
    // 8. the failing step is recorded
    expect(execution.failedStepId).toBe(failing.id);
    // 4/5. the error explains that no element matched, and nothing else was picked
    expect(execution.errorMessage).toMatch(/No element matches selector/i);
    expect(execution.errorMessage).toContain("role=button");
    // 5. the current URL is preserved for diagnosis
    expect(execution.currentUrl).toContain("/errors");

    // The steps after the failure did not run.
    const state = await getTestWebState();
    expect(state.wizardSubmissions).toHaveLength(0);

    const logs = execution.logs ?? [];
    const messages = logs.map((l) => l.message).join("\n");
    expect(messages).toContain("Step 2/5");
    expect(messages).not.toContain("Step 3/5");
    expect(logs.some((l) => l.level === "error" && l.stepId === failing.id)).toBe(true);

    // 9. an error screenshot was stored and can be downloaded
    const screenshot = (execution.artifacts ?? []).find((a) => a.type === "screenshot");
    expect(screenshot, "an error screenshot must be stored").toBeTruthy();
    const file = await fetch(`${APP_BASE_URL}/api/artifacts/${screenshot!.id}/file`, {
      headers: { cookie: client.sessionCookie }
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    // PNG magic number: the artifact really is an image.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 11. a failure notification was created
    const notifications = await client.notifications();
    const failure = notifications.items.find((n) => n.type === "workflow_failed");
    expect(failure).toBeTruthy();
    expect(failure!.message).toContain("Clicca Conferma");
  });

  test("an ambiguous selector stops the workflow instead of picking the first match", async () => {
    const workflow = await client.createWorkflow(
      `Selector ambiguo ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    // The elements page has two radio inputs: this selector is deliberately
    // ambiguous and must never be resolved by choosing one of them.
    const ambiguous = step({
      type: "click",
      name: "Clicca radio ambiguo",
      timeoutMs: 4000,
      selector: {
        strategy: "css",
        value: "input[type=radio]",
        fallback: null,
        pageId: "main",
        frame: null
      }
    });

    await client.putSteps(workflow.id, [
      gotoStep(`${TEST_WEB_INTERNAL_URL}/elements`),
      ambiguous
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(execution.status).toBe("failed");
    expect(execution.failedStepId).toBe(ambiguous.id);
    expect(execution.errorMessage).toMatch(/matches 2 elements/);
    expect(execution.errorMessage).toMatch(/instead of guessing/);
  });

  test("a timeout on a late element fails without hanging the execution", async () => {
    // The delayed button appears well after the step timeout.
    await configureTestWeb({ delayedButtonMs: 30_000 });

    const workflow = await client.createWorkflow(
      `Timeout elemento ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/errors`
    );

    const waiting = step({
      type: "waitForElement",
      name: "Attendi pulsante ritardato",
      timeoutMs: 3000,
      selector: {
        strategy: "id",
        value: "delayed-button",
        fallback: null,
        pageId: "main",
        frame: null
      }
    });

    await client.putSteps(workflow.id, [gotoStep(`${TEST_WEB_INTERNAL_URL}/errors`), waiting]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id, 90_000);

    expect(execution.status).toBe("failed");
    expect(execution.failedStepId).toBe(waiting.id);
    expect((execution.artifacts ?? []).some((a) => a.type === "screenshot")).toBe(true);
  });

  test("the recorded fallback is used only when the primary selector matches nothing", async () => {
    const workflow = await client.createWorkflow(
      `Fallback selector ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    const withFallback = step({
      type: "fill",
      name: "Inserisci con fallback",
      value: "valore-da-fallback",
      timeoutMs: 4000,
      selector: {
        // This label does not exist on the page; the fallback does.
        strategy: "label",
        value: "Etichetta Inesistente",
        fallback: "#text-input",
        pageId: "main",
        frame: null
      }
    });

    await client.putSteps(workflow.id, [
      gotoStep(`${TEST_WEB_INTERNAL_URL}/elements`),
      withFallback,
      step({
        type: "assertVisible",
        name: "Verifica campo testo",
        timeoutMs: 4000,
        selector: { strategy: "id", value: "text-input", fallback: null, pageId: "main", frame: null }
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
    const messages = (execution.logs ?? []).map((l) => l.message).join("\n");
    expect(messages).toMatch(/used the recorded fallback/i);
  });

  test("an unknown template reference fails the step instead of sending an empty value", async () => {
    const workflow = await client.createWorkflow(
      `Variabile mancante ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    const badTemplate = step({
      id: uuid(),
      type: "fill",
      name: "Inserisci variabile inesistente",
      value: "{{variables.non_esiste}}",
      timeoutMs: 4000,
      selector: { strategy: "id", value: "text-input", fallback: null, pageId: "main", frame: null }
    });

    await client.putSteps(workflow.id, [
      gotoStep(`${TEST_WEB_INTERNAL_URL}/elements`),
      badTemplate
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(execution.status).toBe("failed");
    expect(execution.failedStepId).toBe(badTemplate.id);
    expect(execution.errorMessage).toMatch(/Unknown template reference/);
  });
});
