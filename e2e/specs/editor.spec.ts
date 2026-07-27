import { test, expect, type Page } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
  resetTestWeb,
  step
} from "../helpers/app-client";

async function loginThroughUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(SEED_EMAIL);
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

/**
 * Clicks Save and waits for *this* save to land, so assertions on the persisted
 * state cannot race the request. The confirmation in the live log is the wrong
 * thing to wait for when a test saves twice: the line from the first save is
 * already there and the wait returns at once. The unsaved-changes flag belongs
 * to the save in front of us.
 */
async function save(page: Page): Promise<void> {
  // The step form is a modal: it covers the toolbar and has to be closed first,
  // exactly as the user has to close it.
  const done = page.getByTestId("step-form-close");
  if (await done.isVisible().catch(() => false)) await done.click();
  await expect(page.getByTestId("unsaved-changes")).toBeVisible();
  await page.getByTestId("save-steps").click();
  await expect(page.getByTestId("unsaved-changes")).toBeHidden({ timeout: 30_000 });
}

function baseSteps() {
  return [
    step({
      type: "goto",
      name: "Vai al wizard",
      value: `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    }),
    step({
      type: "fill",
      name: "Inserisci Nome",
      value: "Mario",
      selector: {
        strategy: "label",
        value: "Nome",
        fallback: "#fullname",
        pageId: "main",
        frame: null
      }
    }),
    step({
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
    })
  ];
}

test.describe("visual step editor", () => {
  let client: AppClient;
  let workflowId: string;

  test.beforeEach(async ({ page }) => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
    const workflow = await client.createWorkflow(
      `Editor ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    workflowId = workflow.id;
    await client.putSteps(workflowId, baseSteps());

    await loginThroughUi(page);
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.getByTestId("step-list")).toBeVisible();
  });

  test("shows the saved steps in order", async ({ page }) => {
    await expect(page.getByTestId("step-type-0")).toHaveText("goto");
    await expect(page.getByTestId("step-type-1")).toHaveText("fill");
    await expect(page.getByTestId("step-type-2")).toHaveText("click");
    await expect(page.getByTestId("step-name-1")).toHaveText("Inserisci Nome");
  });

  test("renames the workflow itself", async ({ page }) => {
    // The name is chosen once, in the creation form, and a workflow lives for
    // months: the API has always accepted a new one, the page just never offered
    // to send it.
    const renamed = `Editor rinominato ${Date.now()}`;
    await page.getByTestId("rename-workflow").click();
    await page.getByTestId("workflow-name-input").fill(renamed);
    await page.getByTestId("rename-save").click();

    await expect(page.getByTestId("workflow-name")).toHaveText(renamed);
    expect((await client.getWorkflow(workflowId)).name).toBe(renamed);

    await page.reload();
    await expect(page.getByTestId("workflow-name")).toHaveText(renamed);
  });

  test("duplicates a workflow with its steps", async ({ page }) => {
    // A workflow is written once and then varied — the same order for another
    // supplier, the same login for another environment. Without this the only
    // way to vary one was to record it again from scratch.
    const original = `Da duplicare ${Date.now()}`;
    await page.getByTestId("rename-workflow").click();
    await page.getByTestId("workflow-name-input").fill(original);
    await page.getByTestId("rename-save").click();
    await expect(page.getByTestId("workflow-name")).toHaveText(original);

    await page.goto("/workflows");
    await page.getByTestId(`workflow-clone-${original}`).click();

    const copy = `${original} (copia)`;
    await expect(page.getByTestId(`workflow-link-${copy}`)).toBeVisible();

    // The copy carries the steps, and the original is untouched.
    await page.getByTestId(`workflow-link-${copy}`).click();
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(3);
    await expect(page.getByTestId("step-name-1")).toHaveText("Inserisci Nome");

    const stored = await client.getWorkflow(workflowId);
    expect(stored.name, "the original keeps its name").toBe(original);
  });

  test("shows what a referenced value holds, not the reference", async ({ page }) => {
    // `{{variables.repoName}}` says nothing about whether the run will type
    // something or nothing at all, which is the only thing worth seeing at a
    // glance. Saving the steps creates the name, so it exists and is empty.
    const suffix = Date.now();
    await client.putSteps(workflowId, [
      step({
        type: "goto",
        name: "Vai al wizard",
        value: `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
      }),
      step({
        type: "fill",
        name: "Inserisci il nome",
        value: `{{variables.nome${suffix}}}`,
        selector: { strategy: "label", value: "Nome", fallback: null, pageId: "main", frame: null }
      }),
      step({
        type: "fill",
        name: "Inserisci la password",
        value: `{{credentials.segreto${suffix}}}`,
        selector: {
          strategy: "label",
          value: "Password",
          fallback: null,
          pageId: "main",
          frame: null
        }
      })
    ]);

    await page.reload();
    await expect(page.getByTestId("step-value-1")).toContainText("(vuota)");
    await expect(page.getByTestId("step-value-2")).toContainText("(vuota)");

    // Filled in, the variable shows its value and the secret stays hidden: the
    // server never sends it to the browser.
    await client.saveCredential(`nome${suffix}`, "Mario", "variable");
    await client.saveCredential(`segreto${suffix}`, "TestPassword123!", "secret");

    await page.reload();
    await expect(page.getByTestId("step-value-1")).toContainText("Mario");
    await expect(page.getByTestId("step-value-2")).toContainText("••••••");
    await expect(page.getByTestId("step-value-2")).not.toContainText("TestPassword123!");
    // The reference itself is still what the editor holds and would save.
    await expect(page.getByTestId("step-value-2")).toHaveAttribute(
      "title",
      `{{credentials.segreto${suffix}}}`
    );

    // In the form the same rule: what it holds until you go to change it, and
    // then the reference, because that is what typing edits.
    await page.getByTestId("step-edit-1").click();
    const field = page.getByTestId("step-value-input-1");
    await expect(field).toHaveValue("Mario");
    await field.focus();
    await expect(field).toHaveValue(`{{variables.nome${suffix}}}`);
  });

  test("renames a step and persists it", async ({ page }) => {
    await page.getByTestId("step-edit-1").click();
    const nameInput = page.getByTestId("step-name-input-1");
    await nameInput.fill("Inserisci il nome del cliente");
    await save(page);

    await page.reload();
    await expect(page.getByTestId("step-name-1")).toHaveText("Inserisci il nome del cliente");

    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps[1].name).toBe("Inserisci il nome del cliente");
  });

  test("edits the selector and the value and persists them", async ({ page }) => {
    await page.getByTestId("step-edit-1").click();
    await page.getByTestId("step-selector-value-1").fill("Email");
    await page.getByTestId("step-value-input-1").fill("nuovo@example.com");
    await save(page);

    await page.reload();
    const stored = await client.getWorkflow(workflowId);
    expect((stored.steps[1].selector as { value: string }).value).toBe("Email");
    expect(stored.steps[1].value).toBe("nuovo@example.com");
  });

  test("changes the selector strategy", async ({ page }) => {
    await page.getByTestId("step-edit-1").click();
    await page.getByTestId("step-strategy-1").selectOption("css");
    await page.getByTestId("step-selector-value-1").fill("#fullname");
    await save(page);

    const stored = await client.getWorkflow(workflowId);
    expect((stored.steps[1].selector as { strategy: string }).strategy).toBe("css");
    expect((stored.steps[1].selector as { value: string }).value).toBe("#fullname");
  });

  test("reorders steps", async ({ page }) => {
    await page.getByTestId("step-down-1").click();
    await expect(page.getByTestId("step-type-1")).toHaveText("click");
    await expect(page.getByTestId("step-type-2")).toHaveText("fill");

    await save(page);
    await page.reload();
    await expect(page.getByTestId("step-type-1")).toHaveText("click");

    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps.map((s) => s.type)).toEqual(["goto", "click", "fill"]);

    // Moving the first step up is not possible.
    await expect(page.getByTestId("step-up-0")).toBeDisabled();
  });

  test("deletes a step", async ({ page }) => {
    await page.getByTestId("step-delete-2").click();
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(2);

    await save(page);
    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps).toHaveLength(2);
  });

  test("edits a step in a modal that can be dismissed", async ({ page }) => {
    // The form used to unfold inside the row, pushing the rest of the list down
    // and leaving the fields to compete with it for width.
    await page.getByTestId("step-edit-1").click();
    const form = page.getByTestId("step-form-1");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("role", "dialog");

    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
  });

  test("disables a step and everything after it", async ({ page }) => {
    // A step depends on what the steps before it did, so switching one off often
    // means switching off the rest. Asking for that explicitly keeps the plain
    // toggle free of surprises.
    await page.getByTestId("step-disable-from-1").click();
    await expect(page.getByTestId("step-toggle-0")).toHaveText("Disabilita");
    await expect(page.getByTestId("step-toggle-1")).toHaveText("Abilita");
    await expect(page.getByTestId("step-toggle-2")).toHaveText("Abilita");

    await save(page);
    expect((await client.getWorkflow(workflowId)).steps.map((s) => s.enabled)).toEqual([
      true,
      false,
      false
    ]);

    // And the same command brings the tail back.
    await page.getByTestId("step-disable-from-1").click();
    await expect(page.getByTestId("step-toggle-2")).toHaveText("Disabilita");
    await save(page);
    expect((await client.getWorkflow(workflowId)).steps.map((s) => s.enabled)).toEqual([
      true,
      true,
      true
    ]);
  });

  test("disables a step without deleting it", async ({ page }) => {
    await page.getByTestId("step-toggle-1").click();
    await expect(page.getByTestId("step-toggle-1")).toHaveText("Abilita");

    await save(page);
    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps[1].enabled).toBe(false);
    // The workflow still has enabled steps, so it stays ready.
    expect(stored.status).toBe("ready");
  });

  test("adds a wait step", async ({ page }) => {
    await page.getByTestId("add-wait").click();
    await expect(page.getByTestId("step-list").locator("li")).toHaveCount(4);
    await expect(page.getByTestId("step-type-3")).toHaveText("wait");

    await save(page);
    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps[3]).toMatchObject({ type: "wait", value: "1000" });
  });

  test("adds an assertion step", async ({ page }) => {
    await page.getByTestId("add-assertion").click();
    await expect(page.getByTestId("step-type-3")).toHaveText("assertVisible");

    // The new assertion needs a selector value before it can be saved.
    await page.getByTestId("step-edit-3").click();
    await page.getByTestId("step-selector-value-3").fill("Form inviato correttamente");
    await save(page);

    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps[3].type).toBe("assertVisible");
    expect((stored.steps[3].selector as { value: string }).value).toBe(
      "Form inviato correttamente"
    );
  });

  test("keeps the closing action last when a step is added", async ({ page }) => {
    // The closing action is recorded without being performed and must stay last:
    // nothing may depend on an effect nobody observed. The editor appended new
    // steps to the end regardless, so recording a closing action and then adding a
    // wait produced a list the server refuses — and the user had no way to fix it
    // from the editor except by shuffling steps by hand.
    await client.putSteps(workflowId, [
      ...baseSteps(),
      step({
        type: "click",
        name: "Conferma ordine",
        isFinal: true,
        selector: {
          strategy: "css",
          value: "button#confirm",
          fallback: null,
          pageId: "main",
          frame: null
        }
      })
    ]);
    await page.reload();
    await expect(page.getByTestId("step-final-3")).toBeVisible();

    await page.getByTestId("add-wait").click();
    await save(page);

    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps).toHaveLength(5);
    expect(
      stored.steps[stored.steps.length - 1]!.isFinal,
      "the closing action must still be last"
    ).toBe(true);
    expect(stored.steps[stored.steps.length - 2]!.type).toBe("wait");
  });

  test("refuses to move a step past the closing action", async ({ page }) => {
    await client.putSteps(workflowId, [
      ...baseSteps(),
      step({
        type: "click",
        name: "Conferma ordine",
        isFinal: true,
        selector: {
          strategy: "css",
          value: "button#confirm",
          fallback: null,
          pageId: "main",
          frame: null
        }
      })
    ]);
    await page.reload();
    await expect(page.getByTestId("step-final-3")).toBeVisible();

    // Moving the closing action up would put an ordinary step after it.
    await expect(page.getByTestId("step-up-3")).toBeDisabled();
    // And the step before it cannot be pushed past it.
    await expect(page.getByTestId("step-down-2")).toBeDisabled();
  });

  test("reports a validation error instead of saving an invalid step", async ({ page }) => {
    // An assertion with an empty selector value cannot be persisted.
    await page.getByTestId("add-assertion").click();
    await page.getByTestId("save-steps").click();

    await expect(page.getByTestId("recorder-error")).toBeVisible();
    await expect(page.getByTestId("recorder-error")).toContainText("Invalid steps");

    // Nothing was saved.
    const stored = await client.getWorkflow(workflowId);
    expect(stored.steps).toHaveLength(3);
  });

  test("runs the whole workflow from the editor", async ({ page }) => {
    await page.getByTestId("run-now").click();
    await expect(page.getByTestId("execution-detail")).toBeVisible({ timeout: 30_000 });

    const executionId = page.url().split("/executions/")[1];
    const execution = await client.waitForExecution(executionId);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");

    // The detail page shows the live log and the final status.
    await expect(page.getByTestId("execution-status")).toHaveText("completed", { timeout: 30_000 });
    await expect(page.getByTestId("execution-logs")).toContainText("Step 1/3");
    await expect(page.getByTestId("execution-duration")).not.toHaveText("-");
  });
});
