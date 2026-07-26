import { test, expect } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  getTestWebState,
  resetTestWeb
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
