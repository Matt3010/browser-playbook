import { test, expect } from "@playwright/test";
import {
  APP_BASE_URL,
  AppClient,
  SHOP_WEB_INTERNAL_URL,
  TEST_WEB_INTERNAL_URL,
  configureTestWeb,
  getTestWebState,
  resetTestWeb,
  step
} from "../helpers/app-client";

interface ElementInfo {
  tag: string;
  role: string | null;
  accessibleName: string | null;
  label: string | null;
  placeholder: string | null;
  id: string | null;
  text: string | null;
  proposedSelector: string;
  outlineColor: string;
  outlineStyle: string;
  outlineWidth: string;
  disabled: boolean;
  highlightActive: boolean;
}

/** The colours required by section 3.4, as the browser reports them. */
const EXPECTED = {
  input: "rgb(242, 194, 0)", // yellow
  select: "rgb(255, 140, 26)", // orange
  choice: "rgb(139, 92, 246)", // purple
  button: "rgb(229, 72, 77)", // red
  link: "rgb(47, 111, 237)", // blue
  clickable: "rgb(34, 160, 107)", // green
  disabled: "rgb(154, 163, 178)" // grey
};

test.describe("recorder overlay and element inspection", () => {
  let client: AppClient;
  let sessionId: string;

  test.beforeAll(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    sessionId = session.sessionId;
  });

  test.afterAll(async () => {
    if (sessionId) await client.closeSession(sessionId).catch(() => undefined);
  });

  async function describe(selector: string, frame?: string): Promise<ElementInfo> {
    const params = new URLSearchParams({ selector });
    if (frame) params.set("frame", frame);
    const response = await client.request(
      "GET",
      `/api/sessions/${sessionId}/element?${params.toString()}`
    );
    expect(response.status, `describe ${selector}`).toBe(200);
    return response.json<ElementInfo>();
  }

  test("highlights every element category with the documented colour", async () => {
    const cases: Array<[string, string, string]> = [
      ["#text-input", EXPECTED.input, "text input is yellow"],
      ["#area", EXPECTED.input, "textarea is yellow"],
      ["#choice", EXPECTED.select, "select is orange"],
      ["#accept", EXPECTED.choice, "checkbox is purple"],
      ["#ship-express", EXPECTED.choice, "radio is purple"],
      ["#real-button", EXPECTED.button, "button is red"],
      ["#internal-link", EXPECTED.link, "link is blue"],
      ["#fake-button", EXPECTED.clickable, "role=button element is green"],
      ["#disabled-button", EXPECTED.disabled, "disabled button is grey"],
      ["#disabled-input", EXPECTED.disabled, "disabled input is grey"]
    ];

    for (const [selector, color, description] of cases) {
      const info = await describe(selector);
      expect(info.highlightActive, "the overlay must be active").toBe(true);
      expect(info.outlineStyle, description).toBe("solid");
      expect(info.outlineColor, description).toBe(color);
    }
  });

  test("the overlay does not alter the page layout", async () => {
    // Outline is the only property the overlay sets, so element geometry is
    // identical with the overlay on and off.
    const before = await describe("#text-input");
    expect(before.outlineWidth).toBe("2px");

    await client.setHighlight(sessionId, false);
    const off = await describe("#text-input");
    expect(off.highlightActive).toBe(false);
    expect(off.outlineStyle === "none" || off.outlineWidth === "0px").toBe(true);

    await client.setHighlight(sessionId, true);
    const on = await describe("#text-input");
    expect(on.highlightActive).toBe(true);
    expect(on.outlineColor).toBe(EXPECTED.input);
  });

  test("the description panel is off until it is asked for", async () => {
    // It is drawn inside the very page the user is working on, and it says what
    // the "selected element" panel already says, so it starts out of the way —
    // and it is its own switch, not a side effect of the highlight.
    expect((await client.getSession(sessionId)).tooltip).toBe(false);

    await client.setTooltip(sessionId, true);
    expect((await client.getSession(sessionId)).tooltip).toBe(true);
    expect((await client.getSession(sessionId)).highlight, "unchanged by it").toBe(true);

    await client.setTooltip(sessionId, false);
    expect((await client.getSession(sessionId)).tooltip).toBe(false);
  });

  test("element inspection reports everything the tooltip shows", async () => {
    const input = await describe("#text-input");
    expect(input.tag).toBe("input");
    expect(input.role).toBe("textbox");
    expect(input.label).toBe("Campo testo");
    expect(input.placeholder).toBe("Scrivi qui");
    expect(input.id).toBe("text-input");
    expect(input.proposedSelector).toContain("getByRole('textbox'");

    const button = await describe("#real-button");
    expect(button.role).toBe("button");
    expect(button.accessibleName).toBe("Bottone reale");
    expect(button.proposedSelector).toBe("getByRole('button', { name: 'Bottone reale' })");

    const link = await describe("#internal-link");
    expect(link.role).toBe("link");
    expect(link.text).toBe("Vai alla dashboard");

    const disabled = await describe("#disabled-button");
    expect(disabled.disabled).toBe(true);
  });

  test("the overlay works inside a same-origin iframe", async () => {
    const framed = await describe("#frame-input", "#inner");
    expect(framed.tag).toBe("input");
    expect(framed.outlineColor).toBe(EXPECTED.input);
    expect(framed.highlightActive).toBe(true);
  });

  test("the overlay survives a navigation", async () => {
    await client.navigateSession(sessionId, `${TEST_WEB_INTERNAL_URL}/wizard/step-2`);
    const select = await describe("#plan");
    expect(select.highlightActive).toBe(true);
    expect(select.outlineColor).toBe(EXPECTED.select);

    await client.navigateSession(sessionId, `${TEST_WEB_INTERNAL_URL}/elements`);
    const input = await describe("#text-input");
    expect(input.highlightActive).toBe(true);
    expect(input.outlineColor).toBe(EXPECTED.input);
  });
});

test.describe("recorder action capture", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("captures the full range of interactions as structured steps", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);

      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#text-input",
        value: "testo semplice"
      });
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#area",
        value: "note su piu righe"
      });
      await client.interact(session.sessionId, { kind: "select", selector: "#choice", value: "b" });
      await client.interact(session.sessionId, { kind: "check", selector: "#accept" });
      await client.interact(session.sessionId, { kind: "uncheck", selector: "#accept" });
      await client.interact(session.sessionId, { kind: "check", selector: "#ship-express" });
      await client.interact(session.sessionId, { kind: "click", selector: "#real-button" });
      await client.interact(session.sessionId, { kind: "click", selector: "#fake-button" });
      await client.interact(session.sessionId, {
        kind: "press",
        selector: "#text-input",
        value: "Enter"
      });

      const recording = await client.getRecording(session.sessionId);
      const byType = recording.steps.reduce<Record<string, number>>((acc, s) => {
        acc[s.type] = (acc[s.type] ?? 0) + 1;
        return acc;
      }, {});

      // Every interaction became a structured step, never raw coordinates.
      expect(byType.goto).toBeGreaterThanOrEqual(1);
      expect(byType.fill).toBe(2);
      expect(byType.select).toBe(1);
      expect(byType.check).toBe(2);
      expect(byType.uncheck).toBe(1);
      expect(byType.click).toBeGreaterThanOrEqual(2);
      expect(byType.press).toBe(1);

      for (const step of recording.steps) {
        expect(step.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(step.name.length).toBeGreaterThan(0);
        expect(step.timeoutMs).toBeGreaterThan(0);
        if (["click", "fill", "select", "check", "uncheck"].includes(step.type)) {
          expect(step.selector, `${step.type} must carry a selector`).toBeTruthy();
        }
      }

      const select = recording.steps.find((s) => s.type === "select");
      expect(select!.value).toBe("b");

      // Selector strategies follow the documented priority: role first.
      const strategies = recording.steps
        .filter((s) => s.selector)
        .map((s) => (s.selector as { strategy: string }).strategy);
      expect(strategies).toContain("role");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("keeps the required marker out of the recorded name", async () => {
    // The asterisk of a required field is drawn on screen and hidden from the
    // accessibility tree. Reading the label's raw text put it in the recorded
    // name, which then matched nothing: on a real site's required fields the
    // primary selector missed on every run and each such step cost a full
    // timeout before the fallback saved it.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#required-field",
        value: "CL-4471"
      });

      const recording = await client.getRecording(session.sessionId);
      const index = recording.steps.findIndex((s) => s.value === "CL-4471");
      expect(index, "the fill must be recorded").toBeGreaterThanOrEqual(0);

      const selector = recording.steps[index].selector as { name?: string; value?: string };
      expect(JSON.stringify(selector)).not.toContain("*");
      expect(selector.name ?? selector.value).toBe("Codice cliente");

      // And it must resolve as recorded: a name that only the fallback can find
      // is a step that costs its whole timeout on every single run.
      const check = (recording.verifications ?? [])[index] as {
        status: string;
        usedFallback?: boolean;
      };
      expect(check.status).toBe("ok");
      expect(check.usedFallback, "the primary selector must resolve").toBe(false);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("does not record the navigation a click caused, however late it lands", async () => {
    // Whether a navigation belongs to the click before it is a question about
    // cause, and it used to be answered with a stopwatch: a navigation arriving
    // more than a moment after the action was recorded as a separate goto. On a
    // site that answers slowly every transition arrives late, so the workflow
    // replayed each one twice — click, then navigate to where the click had
    // already gone.
    await configureTestWeb({ navigationDelayMs: 2500 });
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/slow-link`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#slow-link" });
      await expect
        .poll(async () => (await client.getSession(session.sessionId)).currentUrl, {
          timeout: 30_000
        })
        .toContain("/slow-target");

      const recording = await client.getRecording(session.sessionId);
      expect(recording.steps.filter((s) => s.type === "click")).toHaveLength(1);
      expect(
        recording.steps.filter((s) => s.value?.includes("/slow-target")),
        "the click already goes there"
      ).toHaveLength(0);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records a navigation the user asked for, even straight after an action", async () => {
    // The other direction, and the same defect: typing an address right after
    // clicking something was swallowed as if the click had caused it.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#real-button" });
      await client.navigateSession(session.sessionId, `${TEST_WEB_INTERNAL_URL}/checkout`);

      await expect
        .poll(
          async () =>
            (await client.getRecording(session.sessionId)).steps.some(
              (s) => s.type === "goto" && (s.value ?? "").includes("/checkout")
            ),
          { timeout: 30_000 }
        )
        .toBe(true);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("gives a recorded step the same id every time it is read", async () => {
    // The editor polls this while recording. Fresh ids on every read mean the
    // list it holds is a different list each second: an open form loses the step
    // it was editing, and anything the user did to the list is undone.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#text-input",
        value: "ciao"
      });
      await client.interact(session.sessionId, { kind: "click", selector: "#real-button" });

      const first = await client.getRecording(session.sessionId);
      const second = await client.getRecording(session.sessionId);

      expect(first.steps.length).toBeGreaterThan(1);
      expect(second.steps.map((s) => s.id)).toEqual(first.steps.map((s) => s.id));

      // And a new action does not renumber the ones already there.
      await client.interact(session.sessionId, { kind: "fill", selector: "#area", value: "nota" });
      const third = await client.getRecording(session.sessionId);
      expect(third.steps.slice(0, first.steps.length).map((s) => s.id)).toEqual(
        first.steps.map((s) => s.id)
      );
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records a new tab as a switchPage step and keeps page ids", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#new-tab-link" });

      await expect
        .poll(async () => (await client.getSession(session.sessionId)).pages.length, {
          timeout: 30_000
        })
        .toBeGreaterThan(1);

      const recording = await client.getRecording(session.sessionId);
      const switchStep = recording.steps.find((s) => s.type === "switchPage");
      expect(switchStep, "opening a tab must be recorded").toBeTruthy();
      expect(switchStep!.value).toBe("tab-1");

      const pages = (await client.getSession(session.sessionId)).pages;
      expect(pages.map((p) => p.pageId)).toEqual(["main", "tab-1"]);
      expect(pages[1].url).toContain("/elements/popup");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records an interaction inside a same-origin iframe with the frame reference", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#frame-input",
        value: "testo nel frame",
        frame: "#inner"
      });

      const recording = await client.getRecording(session.sessionId);
      const framed = recording.steps.find(
        (s) => s.type === "fill" && (s.selector as { frame?: string } | null)?.frame
      );
      expect(framed, "the iframe interaction must be recorded").toBeTruthy();
      expect((framed!.selector as { frame: string }).frame).toBe("#inner");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records a download as a download step", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#download-link" });

      await expect
        .poll(
          async () =>
            (await client.getRecording(session.sessionId)).steps.some((s) => s.type === "download"),
          { timeout: 30_000 }
        )
        .toBe(true);

      const recording = await client.getRecording(session.sessionId);
      const download = recording.steps.find((s) => s.type === "download");
      expect(download!.value).toBe("sample.txt");
      expect(download!.selector).toBeTruthy();
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records a click on a label covering a radio as a single check step", async () => {
    // Reproduces the markup that broke a workflow on a real storefront: the radio
    // is hidden under its own label, and the label text embeds a price.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "click",
        selector: "#_r_b_label"
      });

      await expect
        .poll(
          async () =>
            (await client.getRecording(session.sessionId)).steps.filter((s) =>
              ["check", "click"].includes(s.type)
            ).length,
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0);

      const recording = await client.getRecording(session.sessionId);
      const actions = recording.steps.filter((s) => ["check", "click", "uncheck"].includes(s.type));

      // One interaction must produce exactly one step, and it must be the check.
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("check");

      // The selector must not embed the price, and must address the radio by
      // name and value rather than by its framework-generated id.
      const selector = actions[0].selector as { strategy: string; value?: string };
      expect(JSON.stringify(selector)).not.toContain("1.749,00");
      expect(JSON.stringify(selector)).not.toContain("_r_b_");
      expect(selector.strategy).toBe("css");
      expect(selector.value).toBe('input[name="size-choice"][value="15inch"]');
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records a manual wait requested from the UI", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      const response = await client.request("POST", `/api/sessions/${session.sessionId}/wait`, {
        ms: 1500
      });
      expect(response.status).toBe(200);

      const recording = await client.getRecording(session.sessionId);
      const wait = recording.steps.find((s) => s.type === "wait");
      expect(wait, "a manual wait must be recorded").toBeTruthy();
      expect(wait!.value).toBe("1500");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("records nothing while recording is stopped", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#text-input",
        value: "non registrato"
      });
      const before = await client.getRecording(session.sessionId);
      expect(before.steps).toHaveLength(0);

      await client.setRecording(session.sessionId, true);
      await client.setRecording(session.sessionId, false);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#text-input",
        value: "neanche questo"
      });

      const after = await client.getRecording(session.sessionId);
      // Only the initial goto seeded when recording started.
      expect(after.steps.filter((s) => s.type === "fill")).toHaveLength(0);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });
});

test.describe("closing action captured without being performed", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("records the final click, does not perform it, and runs it only on execution", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/checkout`);
    try {
      await client.setRecording(session.sessionId, true);

      // A normal step first, which must really happen while recording.
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#order-note",
        value: "consegna al piano"
      });

      // Arm, then click the destructive button.
      await client.armFinal(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#place-order" });

      // The order must NOT have been placed.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect((await getTestWebState()).orders, "no order may be placed while recording").toHaveLength(
        0
      );

      // The page did not even navigate away from the checkout form.
      const info = await client.getSession(session.sessionId);
      expect(info.currentUrl).toContain("/checkout");

      // The action was recorded, marked final, and recording stopped by itself.
      const recording = await client.getRecording(session.sessionId);
      const final = recording.steps.find((s) => s.isFinal);
      expect(final, "the closing action must be recorded").toBeTruthy();
      expect(final!.type).toBe("click");
      expect(final).toBe(recording.steps[recording.steps.length - 1]);
      expect(recording.steps.filter((s) => s.isFinal)).toHaveLength(1);
      expect((await client.getSession(session.sessionId)).recording).toBe(false);

      // Saving keeps the flag, and the workflow becomes runnable.
      const workflow = await client.createWorkflow(
        `Closing action ${Date.now()}`,
        `${TEST_WEB_INTERNAL_URL}/checkout`
      );
      const saved = await client.putSteps(workflow.id, recording.steps);
      expect(saved[saved.length - 1].isFinal).toBe(true);

      // Running the workflow performs it for real.
      const started = await client.runNow(workflow.id);
      const execution = await client.waitForExecution(started.id);
      expect(
        execution.status,
        `execution failed: ${execution.errorMessage ?? ""}`
      ).toBe("completed");

      const state = await getTestWebState();
      expect(state.orders, "the order must be placed when the workflow runs").toHaveLength(1);
      expect(state.orders[0].note).toBe("consegna al piano");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("waits for the closing action to land before closing the browser", async () => {
    // The last step has nothing after it to wait on: the runner recorded the URL
    // and tore the browser down within half a second of the click, while the
    // request that click had just sent was still in flight. For the one step
    // whose entire purpose is to act on the site, that is the wrong moment to
    // let go — and the execution then reports the page it left, not where it
    // landed.
    await configureTestWeb({ checkoutDelayMs: 3000 });
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/checkout`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.armFinal(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#place-order" });
      await expect
        .poll(
          async () => (await client.getRecording(session.sessionId)).steps.some((s) => s.isFinal),
          { timeout: 30_000 }
        )
        .toBe(true);

      const recording = await client.getRecording(session.sessionId);
      const workflow = await client.createWorkflow(
        `Azione finale lenta ${Date.now()}`,
        `${TEST_WEB_INTERNAL_URL}/checkout`
      );
      await client.putSteps(workflow.id, recording.steps);

      const execution = await client.waitForExecution((await client.runNow(workflow.id)).id);
      expect(
        execution.status,
        `execution failed: ${execution.errorMessage ?? ""}`
      ).toBe("completed");
      expect(execution.currentUrl, "the execution must report where it landed").toContain(
        "/checkout/confirmed"
      );
      expect((await getTestWebState()).orders).toHaveLength(1);
      expect(
        (execution.artifacts ?? []).some((a) => a.type === "screenshot"),
        "the result of the closing action must be shown, not only described"
      ).toBe(true);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("photographs the result of the last step, closing action or not", async () => {
    // What the run produced is a picture, not a URL: the page may have been
    // replaced by a confirmation, or merely rearranged in place. Only failures
    // used to leave anything to look at, and the browser is gone moments later.
    const workflow = await client.createWorkflow(
      `Risultato finale ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/checkout`
    );
    await client.putSteps(workflow.id, [
      step({
        type: "goto",
        name: "Vai al checkout",
        value: `${TEST_WEB_INTERNAL_URL}/checkout`
      }),
      step({
        type: "fill",
        name: "Inserisci la nota",
        value: "consegna al piano",
        selector: { strategy: "id", value: "order-note", fallback: null, pageId: "main", frame: null }
      }),
      // An ordinary last step: nothing here is marked as a closing action.
      step({
        type: "click",
        name: "Clicca Acquista ora",
        selector: { strategy: "id", value: "place-order", fallback: null, pageId: "main", frame: null }
      })
    ]);

    const execution = await client.waitForExecution((await client.runNow(workflow.id)).id);
    expect(execution.status, `execution failed: ${execution.errorMessage ?? ""}`).toBe("completed");

    const shot = (execution.artifacts ?? []).find((a) => a.type === "screenshot");
    expect(shot, "a completed run must leave a picture of where it ended").toBeTruthy();

    const file = await fetch(`${APP_BASE_URL}/api/artifacts/${shot!.id}/file`, {
      headers: { cookie: client.sessionCookie }
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("refuses a second closing action and refuses arming outside recording", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/checkout`);
    try {
      // Not recording yet: arming makes no sense.
      const early = await client.request(
        "POST",
        `/api/sessions/${session.sessionId}/arm-final`,
        { enabled: true }
      );
      expect(early.status).toBe(409);

      await client.setRecording(session.sessionId, true);
      await client.armFinal(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: "#place-order" });

      await expect
        .poll(async () => (await client.getRecording(session.sessionId)).steps.some((s) => s.isFinal), {
          timeout: 30_000
        })
        .toBe(true);

      // Recording cannot be resumed once a closing action exists: anything
      // recorded afterwards would sit after it and could never be saved.
      const resume = await client.request(
        "POST",
        `/api/sessions/${session.sessionId}/recording`,
        { enabled: true }
      );
      expect(resume.status).toBe(409);
      expect(resume.text).toMatch(/closing action/i);

      // Arming a second closing action is refused too.
      const second = await client.request(
        "POST",
        `/api/sessions/${session.sessionId}/arm-final`,
        { enabled: true }
      );
      expect(second.status).toBe(409);
      expect(second.text).toMatch(/already has a closing action/);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("the API refuses to save a closing action that is not last", async () => {
    const workflow = await client.createWorkflow(
      `Closing action fuori posto ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/checkout`
    );

    const response = await client.request("PUT", `/api/workflows/${workflow.id}/steps`, {
      steps: [
        {
          id: crypto.randomUUID(),
          type: "goto",
          name: "Vai al checkout",
          pageId: "main",
          selector: null,
          value: `${TEST_WEB_INTERNAL_URL}/checkout`,
          timeoutMs: 15000,
          enabled: true,
          isFinal: true
        },
        {
          id: crypto.randomUUID(),
          type: "click",
          name: "Clicca dopo l'azione finale",
          pageId: "main",
          selector: { strategy: "id", value: "place-order", fallback: null, pageId: "main", frame: null },
          value: null,
          timeoutMs: 15000,
          enabled: true,
          isFinal: false
        }
      ]
    });

    expect(response.status).toBe(400);
    expect(response.text).toMatch(/must be the last enabled step/);
  });
});

test.describe("credentials recorded on different sites", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  /** Records a login and stores whatever credential it captured. */
  async function recordLogin(startUrl: string, password: string): Promise<string[]> {
    const session = await client.createSession(`${startUrl}/login`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#email",
        value: "test@example.com"
      });
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#password",
        value: password
      });
      const saved = await client.saveRecordedCredentials(session.sessionId);
      // What this recording captured, whether it was written or reused: a name
      // the user already had is kept as it is, which is the point of asking.
      return [...saved.saved, ...(saved.kept ?? [])];
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }

  test("recording a second site does not overwrite the first site's secret", async () => {
    // Every login form calls the field "password". Named after the field alone,
    // the second recording would replace the first site's secret and leave the
    // first workflow signing in with the wrong one.
    const first = await recordLogin(TEST_WEB_INTERNAL_URL, "TestPassword123!");
    const second = await recordLogin(SHOP_WEB_INTERNAL_URL, "UnaAltraPassword999!");

    expect(first[0]).not.toBe(second[0]);
    expect(first[0]).toContain("test_web");
    expect(second[0]).toContain("shop_web");

    // Both exist side by side, and neither value is readable through the API.
    const stored = await client.listCredentials();
    const names = stored.map((c) => c.name);
    expect(names).toContain(first[0]);
    expect(names).toContain(second[0]);
    for (const credential of stored) {
      if (credential.kind === "secret") expect(credential.value).toBeNull();
    }
  });

  test("the first workflow still signs in after the second site is recorded", async () => {
    // The decisive check: the secret the first workflow uses must still be the
    // right one, which only a successful login can prove.
    const firstNames = await recordLogin(TEST_WEB_INTERNAL_URL, "TestPassword123!");
    await recordLogin(SHOP_WEB_INTERNAL_URL, "UnaAltraPassword999!");

    const workflow = await client.createWorkflow(
      `Login dopo secondo sito ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/login`
    );
    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai al login", value: `${TEST_WEB_INTERNAL_URL}/login` }),
      step({
        type: "fill",
        name: "Inserisci Email",
        value: "test@example.com",
        selector: { strategy: "id", value: "email", fallback: null, pageId: "main", frame: null }
      }),
      step({
        type: "fill",
        name: "Inserisci Password",
        value: `{{credentials.${firstNames[0]}}}`,
        selector: { strategy: "id", value: "password", fallback: null, pageId: "main", frame: null }
      }),
      step({
        type: "click",
        name: "Clicca Login",
        selector: {
          strategy: "role",
          role: "button",
          name: "Login",
          fallback: "button[type=submit]",
          pageId: "main",
          frame: null
        }
      }),
      step({
        type: "assertVisible",
        name: "Verifica di essere sulla dashboard",
        selector: { strategy: "testid", value: "welcome", fallback: null, pageId: "main", frame: null }
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `the first workflow must still log in: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
    expect(execution.currentUrl).toContain("/dashboard");
  });
});

test.describe("verifying a recording as it happens", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("marks a step whose selector really resolves as verified", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#text-input",
        value: "testo"
      });

      await expect
        .poll(
          async () => {
            const recording = await client.getRecording(session.sessionId);
            return recording.verifications?.[recording.steps.length - 1]?.status;
          },
          { timeout: 20_000 }
        )
        .toBe("ok");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("catches a selector that stops being unique the moment it is used", async () => {
    // The button clones itself when clicked, which is what a re-rendering list or
    // an "add another" control does. The recorder saw one element and recorded a
    // name-based selector; a moment later there are two, so the step would stop
    // the workflow at run time. Checking against the page right after the
    // interaction is what surfaces it now instead of at three in the morning.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "click", selector: ".clone-me" });

      await expect
        .poll(
          async () => {
            const recording = await client.getRecording(session.sessionId);
            return (recording.verifications ?? []).map((v) => v.status);
          },
          { timeout: 20_000 }
        )
        .toContain("ambiguous");

      const recording = await client.getRecording(session.sessionId);
      const failed = (recording.verifications ?? []).find((v) => v.status === "ambiguous");
      expect(failed!.message).toMatch(/matches \d+ elements/);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("proposes the selector it is actually going to record", async () => {
    // The recorder UI shows a proposed selector for the hovered/selected element.
    // It used to be computed by a second implementation living inside the injected
    // script, which never learned the rules added later: on a storefront radio
    // labelled with a price it proposed getByRole(... '15" Da EUR 1.749,00 ...'),
    // a selector that breaks at the next price change, while the recorder stored a
    // stable one. What the interface promises must be what it stores.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/elements`);
    try {
      const target = 'input[name="size-choice"][value="15inch"]';
      const params = new URLSearchParams({ selector: target });
      const response = await client.request(
        "GET",
        `/api/sessions/${session.sessionId}/element?${params.toString()}`
      );
      expect(response.status).toBe(200);
      const proposed = response.json<{ proposedSelector: string }>().proposedSelector;

      expect(proposed, "a price must never reach the proposed selector").not.toMatch(/\d,\d{2}/);

      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, { kind: "check", selector: target });

      await expect
        .poll(
          async () => (await client.getRecording(session.sessionId)).steps.length,
          { timeout: 20_000 }
        )
        .toBeGreaterThan(0);

      const recording = await client.getRecording(session.sessionId);
      const stored = recording.steps[recording.steps.length - 1]!.selector!;
      expect(proposed, "the proposal must name the stored selector").toContain(stored.value);
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("does not cry wolf when a click navigates away", async () => {
    // The click that submits the login moves the page before the check can run.
    // Reporting that as a broken step would make the whole feature untrustworthy.
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/login`);
    try {
      await client.setRecording(session.sessionId, true);
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#email",
        value: "test@example.com"
      });
      await client.interact(session.sessionId, {
        kind: "fill",
        selector: "#password",
        value: "TestPassword123!"
      });
      await client.interact(session.sessionId, { kind: "click", selector: "button[type=submit]" });

      await expect
        .poll(async () => (await client.getSession(session.sessionId)).currentUrl, {
          timeout: 30_000
        })
        .toContain("/dashboard");

      const recording = await client.getRecording(session.sessionId);
      const statuses = (recording.verifications ?? []).map((v) => v.status);
      // Nothing may be reported as broken: the fills resolved, and the click is
      // simply unverifiable once the page has moved on.
      expect(statuses).not.toContain("ambiguous");
      expect(statuses).not.toContain("not-found");
      expect(statuses).toContain("ok");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });
});
