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
 * Clicks Save and waits for the confirmation in the live log, so assertions on
 * the persisted state cannot race the request.
 */
async function save(page: Page): Promise<void> {
  await page.getByTestId("save-steps").click();
  await expect(page.getByTestId("live-log")).toContainText("step salvati", { timeout: 30_000 });
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
