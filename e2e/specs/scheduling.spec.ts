import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  getTestWebState,
  resetTestWeb,
  step
} from "../helpers/app-client";

const COMPOSE_FILE = process.env.COMPOSE_TEST_FILE ?? "docker-compose.test.yml";

function gotoStep(url: string) {
  return step({ type: "goto", name: `Vai a ${url}`, value: url });
}

/** A short workflow that submits the wizard, so its effect is observable. */
function wizardSteps(name: string) {
  return [
    gotoStep(`${TEST_WEB_INTERNAL_URL}/wizard/step-1`),
    step({
      type: "fill",
      name: "Inserisci Nome",
      value: name,
      selector: { strategy: "label", value: "Nome", fallback: "#fullname", pageId: "main", frame: null }
    }),
    step({
      type: "fill",
      name: "Inserisci Email",
      value: "schedulato@example.com",
      selector: {
        strategy: "label",
        value: "Email",
        fallback: "#wizard-email",
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
    }),
    step({
      type: "click",
      name: "Clicca Completa",
      selector: {
        strategy: "role",
        role: "button",
        name: "Completa",
        fallback: "button[type=submit]",
        pageId: "main",
        frame: null
      }
    }),
    step({
      type: "assertText",
      name: "Verifica messaggio finale",
      value: "Form inviato correttamente",
      selector: {
        strategy: "testid",
        value: "complete-message",
        fallback: null,
        pageId: "main",
        frame: null
      }
    })
  ];
}

test.describe("single future schedule", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("a scheduled job is persisted, started by the worker and completes", async () => {
    const workflow = await client.createWorkflow(
      `Schedulato ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    await client.putSteps(workflow.id, wizardSteps("Utente Pianificato"));

    const runAt = new Date(Date.now() + 6000).toISOString();
    const schedule = await client.schedule(workflow.id, runAt, "Europe/Rome");

    // 3. the job is persisted in the queue, not in an in-memory timer
    expect(schedule.status).toBe("scheduled");
    expect(schedule.queueJobId).toBeTruthy();
    const pending = await client.getSchedule(schedule.id);
    expect(pending.jobState).toBe("delayed");

    // The execution row exists up front, queued and linked to the schedule.
    const queued = await client.getExecution(schedule.executionId);
    expect(queued.status).toBe("queued");

    // 4/5. the worker picks it up and the execution finishes
    const execution = await client.waitForExecution(schedule.executionId, 120_000);
    expect(
      execution.status,
      `scheduled execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
    expect(execution.startedAt).not.toBeNull();
    expect(execution.finishedAt).not.toBeNull();

    // 6. the schedule reaches its final state
    await expect
      .poll(async () => (await client.getSchedule(schedule.id)).status, { timeout: 30_000 })
      .toBe("completed");

    // The workflow really ran: test-web received the submission.
    const state = await getTestWebState();
    expect(state.wizardSubmissions.at(-1)).toMatchObject({
      name: "Utente Pianificato",
      email: "schedulato@example.com"
    });

    // A "scheduled run started" notification was created.
    const notifications = await client.notifications();
    expect(notifications.items.map((n) => n.type)).toContain("schedule_started");
  });

  test("a schedule can be cancelled before it starts", async () => {
    const workflow = await client.createWorkflow(
      `Da annullare ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    await client.putSteps(workflow.id, wizardSteps("Non deve partire"));

    const schedule = await client.schedule(
      workflow.id,
      new Date(Date.now() + 120_000).toISOString()
    );

    const cancelled = await client.cancelSchedule(schedule.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json<{ status: string }>().status).toBe("cancelled");

    // The queue job is gone and the execution is cancelled.
    expect((await client.getSchedule(schedule.id)).jobState).toBeNull();
    expect((await client.getExecution(schedule.executionId)).status).toBe("cancelled");

    // Cancelling twice is refused.
    const again = await client.cancelSchedule(schedule.id);
    expect(again.status).toBe(409);

    // Nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await getTestWebState()).wizardSubmissions).toHaveLength(0);
  });

  test("a scheduled job survives a restart of the worker and the API", async () => {
    const workflow = await client.createWorkflow(
      `Sopravvive al restart ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    await client.putSteps(workflow.id, wizardSteps("Utente Dopo Restart"));

    // Far enough ahead that the restart happens before the job is due.
    const schedule = await client.schedule(
      workflow.id,
      new Date(Date.now() + 45_000).toISOString()
    );
    expect((await client.getSchedule(schedule.id)).jobState).toBe("delayed");

    // Restart the containers that hold the queue producer and consumer. The job
    // lives in Redis, so it must still fire.
    execFileSync("docker", ["compose", "-f", COMPOSE_FILE, "restart", "worker", "api"], {
      encoding: "utf8",
      timeout: 180_000
    });

    // Wait for the API to answer again after the restart.
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${client.baseUrl}/health`);
            return response.status;
          } catch {
            return 0;
          }
        },
        { timeout: 120_000, intervals: [1000] }
      )
      .toBe(200);

    // The cookie survives (it is a JWT), but log in again to be safe.
    await client.login();

    const execution = await client.waitForExecution(schedule.executionId, 150_000);
    expect(
      execution.status,
      `execution after restart failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");

    const state = await getTestWebState();
    expect(state.wizardSubmissions.at(-1)).toMatchObject({ name: "Utente Dopo Restart" });
  });

  test("scheduling in the past or with an invalid timezone is refused", async () => {
    const workflow = await client.createWorkflow(
      `Pianificazione invalida ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    await client.putSteps(workflow.id, wizardSteps("Mai eseguito"));

    const past = await client.request("POST", `/api/workflows/${workflow.id}/schedules`, {
      runAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "Europe/Rome"
    });
    expect(past.status).toBe(400);

    const badZone = await client.request("POST", `/api/workflows/${workflow.id}/schedules`, {
      runAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: "Mars/Olympus"
    });
    expect(badZone.status).toBe(400);
  });

  test("a recurring schedule runs by itself, again and again", async () => {
    // The real proof of a recurrence is the second occurrence: the queue fires
    // it on its own clock, and each one has to make an execution row of its own
    // — nothing is reserved for it when the schedule is saved.
    const workflow = await client.createWorkflow(
      `Ricorrente ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    await client.putSteps(workflow.id, [gotoStep(`${TEST_WEB_INTERNAL_URL}/elements`)]);

    const created = await client.scheduleRecurring(workflow.id, { kind: "hourly", minute: 0 });
    expect(created.cron).toBe("0 * * * *");
    expect(created.runAt).toBeNull();
    expect(
      await client.listExecutions(workflow.id),
      "a recurrence reserves nothing"
    ).toHaveLength(0);

    // Every minute, so the test can watch it happen rather than take the
    // schedule's word for it.
    const everyMinute = await client.scheduleRecurring(workflow.id, {
      kind: "minutes",
      every: 1
    });
    expect(everyMinute.cron).toBe("*/1 * * * *");

    await expect
      .poll(async () => (await client.listExecutions(workflow.id)).length, { timeout: 150_000 })
      .toBeGreaterThanOrEqual(1);

    const first = (await client.listExecutions(workflow.id))[0];
    const finished = await client.waitForExecution(first.id);
    expect(finished.status, `execution failed: ${finished.errorMessage ?? ""}`).toBe("completed");

    // Cancelling stops the next one from ever being created.
    await client.cancelSchedule(everyMinute.id);
    await client.cancelSchedule(created.id);
    const afterCancel = (await client.listExecutions(workflow.id)).length;
    await new Promise((resolve) => setTimeout(resolve, 70_000));
    expect(
      (await client.listExecutions(workflow.id)).length,
      "a cancelled recurrence must never fire again"
    ).toBe(afterCancel);
  });

  test("a formula in a variable makes every run type something new", async () => {
    // The wall a repeating workflow hits: the site wants a name it has not seen.
    // Without this the second run fails with "already exists" and the schedule
    // quietly becomes a nightly failure.
    const suffix = Date.now();
    await client.saveCredential(`nomeUnico${suffix}`, `Utente-{{timestamp}}-{{random:4}}`, "variable");

    const workflow = await client.createWorkflow(
      `Con formula ${suffix}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    await client.putSteps(workflow.id, wizardSteps(`{{variables.nomeUnico${suffix}}}`));

    const before = (await getTestWebState()).wizardSubmissions.length;

    const first = await client.waitForExecution((await client.runNow(workflow.id)).id);
    expect(first.status, `execution failed: ${first.errorMessage ?? ""}`).toBe("completed");
    // A second apart, so the timestamp itself has moved on too.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await client.waitForExecution((await client.runNow(workflow.id)).id);
    expect(second.status, `execution failed: ${second.errorMessage ?? ""}`).toBe("completed");

    const submissions = (await getTestWebState()).wizardSubmissions.slice(before);
    expect(submissions).toHaveLength(2);
    expect(submissions[0].name).toMatch(/^Utente-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(
      submissions[1].name,
      "a repeating workflow must not send the same name twice"
    ).not.toBe(submissions[0].name);
  });

  test("the recurring UI creates a schedule that reads back as a sentence", async ({ page }) => {
    const workflow = await client.createWorkflow(
      `Ricorrente UI ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );
    await client.putSteps(workflow.id, [gotoStep(`${TEST_WEB_INTERNAL_URL}/elements`)]);

    await page.goto("/login");
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("TestPassword123!");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.getByTestId("dashboard")).toBeVisible();

    await page.goto(`/workflows/${workflow.id}`);

    await page.getByTestId("repeat-kind").selectOption("weekly");
    await page.getByTestId("repeat-weekday").selectOption("1");
    await page.getByTestId("repeat-time").fill("07:30");
    await expect(page.getByTestId("repeat-preview")).toHaveText("ogni lunedì alle 07:30");

    await page.getByTestId("repeat-submit").click();

    // Read back from what was stored, not from what was typed.
    await expect(page.getByTestId("schedule-when").first()).toHaveText(
      "ogni lunedì alle 07:30",
      { timeout: 30_000 }
    );
    await expect(page.getByTestId("schedule-status").first()).toHaveText("scheduled");

    await page.getByTestId("schedule-cancel").first().click();
    await expect(page.getByTestId("schedule-status").first()).toHaveText("cancelled", {
      timeout: 30_000
    });
  });

  test("the scheduling UI creates and cancels a schedule", async ({ page }) => {
    const workflow = await client.createWorkflow(
      `Pianifica da UI ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    await client.putSteps(workflow.id, wizardSteps("Utente UI"));

    await page.goto("/login");
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("TestPassword123!");
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page.getByTestId("dashboard")).toBeVisible();

    await page.goto(`/workflows/${workflow.id}`);

    // datetime-local expects local time without a timezone suffix.
    const future = new Date(Date.now() + 10 * 60_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);

    await page.getByTestId("schedule-run-at").fill(local);
    await page.getByTestId("schedule-submit").click();

    await expect(page.getByTestId("schedule-list")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("schedule-status").first()).toHaveText("scheduled");

    await page.getByTestId("schedule-cancel").first().click();
    await expect(page.getByTestId("schedule-status").first()).toHaveText("cancelled", {
      timeout: 30_000
    });
  });
});
