import { test, expect } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  configureTestWeb,
  getTestWebState,
  resetTestWeb,
  step
} from "../helpers/app-client";

function sel(
  strategy: string,
  value: string,
  extra: Partial<{ fallback: string | null; pageId: string; frame: string | null }> = {}
) {
  return {
    strategy,
    value,
    fallback: null,
    pageId: "main",
    frame: null,
    ...extra
  };
}

test.describe("step execution", () => {
  let client: AppClient;

  test.beforeEach(async () => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
  });

  test("executes all fourteen supported step types in one workflow", async () => {
    // The delayed button must appear within the waitForElement timeout.
    await configureTestWeb({ delayedButtonMs: 800 });

    const workflow = await client.createWorkflow(
      `Tutti gli step ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    const steps = [
      // goto
      step({
        type: "goto",
        name: "Vai agli elementi",
        value: `${TEST_WEB_INTERNAL_URL}/elements`
      }),
      // fill
      step({
        type: "fill",
        name: "Inserisci Campo testo",
        value: "valore digitato",
        selector: sel("label", "Campo testo", { fallback: "#text-input" })
      }),
      // select
      step({
        type: "select",
        name: "Seleziona opzione",
        value: "b",
        selector: sel("label", "Selezione", { fallback: "#choice" })
      }),
      // check
      step({
        type: "check",
        name: "Accetta i termini",
        selector: sel("label", "Accetto i termini", { fallback: "#accept" })
      }),
      // uncheck
      step({
        type: "uncheck",
        name: "Deseleziona i termini",
        selector: sel("label", "Accetto i termini", { fallback: "#accept" })
      }),
      // press
      step({
        type: "press",
        name: "Premi Tab",
        value: "Tab",
        selector: sel("id", "text-input")
      }),
      // wait
      step({ type: "wait", name: "Attendi 300 ms", value: "300" }),
      // assertVisible
      step({
        type: "assertVisible",
        name: "Verifica bottone reale",
        selector: {
          strategy: "role",
          role: "button",
          name: "Bottone reale",
          fallback: "#real-button",
          pageId: "main",
          frame: null
        }
      }),
      // assertText
      step({
        type: "assertText",
        name: "Verifica testo del link",
        value: "Vai alla dashboard",
        selector: sel("id", "internal-link")
      }),
      // upload
      step({
        type: "upload",
        name: "Carica il file di test",
        value: "sample-upload.txt",
        selector: sel("id", "upload")
      }),
      // click (submits the upload form)
      step({
        type: "click",
        name: "Clicca Invia file",
        selector: {
          strategy: "role",
          role: "button",
          name: "Invia file",
          fallback: "button[type=submit]",
          pageId: "main",
          frame: null
        }
      }),
      // assertText on the upload result page
      step({
        type: "assertText",
        name: "Verifica nome file caricato",
        value: "sample-upload.txt",
        selector: sel("testid", "upload-filename")
      }),
      // back to the elements page
      step({
        type: "goto",
        name: "Torna agli elementi",
        value: `${TEST_WEB_INTERNAL_URL}/elements`
      }),
      // download
      step({
        type: "download",
        name: "Scarica il file di esempio",
        selector: sel("id", "download-link")
      }),
      // click that opens a new tab
      step({
        type: "click",
        name: "Apri nuova tab",
        selector: sel("id", "new-tab-link")
      }),
      // switchPage
      step({ type: "switchPage", name: "Passa alla nuova tab", value: "tab-1" }),
      // assertText inside the new tab
      step({
        type: "assertText",
        name: "Verifica testo nella nuova tab",
        value: "aperta in una nuova tab",
        pageId: "tab-1",
        selector: sel("testid", "popup-message", { pageId: "tab-1" })
      }),
      // back to the main tab
      step({ type: "switchPage", name: "Torna alla tab principale", value: "main" }),
      // waitForElement on a late element
      step({
        type: "goto",
        name: "Vai agli errori",
        value: `${TEST_WEB_INTERNAL_URL}/errors`
      }),
      step({
        type: "waitForElement",
        name: "Attendi il pulsante ritardato",
        timeoutMs: 20000,
        selector: sel("id", "delayed-button")
      })
    ];

    const saved = await client.putSteps(workflow.id, steps);
    expect(saved).toHaveLength(steps.length);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""} (step ${execution.failedStepId ?? "-"})`
    ).toBe("completed");

    // The upload really reached test-web with the fixture content.
    const state = await getTestWebState();
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0].filename).toBe("sample-upload.txt");
    expect(state.uploads[0].content).toContain("contenuto-upload-di-test");

    // The download was stored as an artifact.
    const download = (execution.artifacts ?? []).find((a) => a.type === "download");
    expect(download, "the downloaded file must be stored as an artifact").toBeTruthy();
    expect(download!.path).toContain("sample.txt");

    // Every step produced a log line with its duration.
    const messages = (execution.logs ?? []).map((l) => l.message).join("\n");
    for (let i = 1; i <= steps.length; i += 1) {
      expect(messages, `step ${i} must be logged`).toContain(`Step ${i}/${steps.length}`);
    }
    expect(execution.currentUrl).toContain("/errors");
  });

  test("checks a radio that is hidden underneath its own label", async () => {
    // Playwright refuses a normal click here because the label intercepts the
    // pointer; the runner must still be able to select the option.
    const workflow = await client.createWorkflow(
      `Radio coperto ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      step({
        type: "check",
        name: "Scegli 15 pollici",
        selector: sel("css", 'input[name="size-choice"][value="15inch"]')
      }),
      step({
        type: "assertText",
        name: "Verifica la scelta",
        value: "15inch",
        selector: sel("testid", "size-result")
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");

    // The runner reported which way it delivered the click: on the label, the way a
    // person would, not forced through to the covered input.
    const messages = (execution.logs ?? []).map((l) => l.message).join("\n");
    expect(messages).toMatch(/covered by its own label; clicking the label instead/i);
    expect(messages).not.toMatch(/delivering the action to it directly/i);
  });

  test("selects a radio whose state is owned by the page's own code", async () => {
    // Found on a real storefront: the input is hidden under its label and the
    // browser's default toggle is suppressed, so only the label's handler changes
    // the selection. Bypassing the overlay check and forcing a click on the input
    // leaves it unchanged and Playwright reports "did not change its state".
    const workflow = await client.createWorkflow(
      `Radio controllato ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      step({
        type: "check",
        name: "Scegli 15 pollici controllato",
        selector: sel("css", 'input[name="controlled-size"][value="15inch"]')
      }),
      step({
        type: "assertText",
        name: "Verifica la scelta controllata",
        value: "15inch",
        selector: sel("testid", "controlled-result")
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
  });

  test("a click step on a covered element still succeeds", async () => {
    // Workflows recorded before the recorder learned to emit `check` here store a
    // `click`; they must keep working.
    const workflow = await client.createWorkflow(
      `Click su elemento coperto ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      step({
        type: "click",
        name: "Clicca 15 pollici",
        selector: sel("css", 'input[name="size-choice"][value="15inch"]')
      }),
      step({
        type: "assertText",
        name: "Verifica la scelta",
        value: "15inch",
        selector: sel("testid", "size-result")
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
  });

  test("survives a site that redirects itself during the navigation", async () => {
    // /redirecting sends the browser to /elements as soon as it loads, which makes
    // Playwright's goto report "interrupted by another navigation".
    const workflow = await client.createWorkflow(
      `Redirect durante goto ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/redirecting`
    );

    await client.putSteps(workflow.id, [
      step({
        type: "goto",
        name: "Vai alla pagina che redirige",
        value: `${TEST_WEB_INTERNAL_URL}/redirecting`
      }),
      step({
        type: "assertVisible",
        name: "Verifica di essere arrivato agli elementi",
        selector: sel("id", "text-input")
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
    expect(execution.currentUrl).toContain("/elements");

    // Whether the redirect lands before or after domcontentloaded is up to the
    // browser's timing, so only the outcome is asserted here: the workflow must
    // not fail either way. The "interrupted by another navigation" branch itself
    // is covered deterministically by the unit tests in
    // apps/worker/src/runner/navigation.test.ts.
    const messages = (execution.logs ?? []).map((l) => l.message).join("\n");
    expect(messages).toContain("Step 2/2");
  });

  test("a session starts even when the start page redirects itself", async () => {
    const session = await client.createSession(`${TEST_WEB_INTERNAL_URL}/redirecting`);
    try {
      expect(session.state).toBe("ready");
      await expect
        .poll(async () => (await client.getSession(session.sessionId)).currentUrl, {
          timeout: 30_000
        })
        .toContain("/elements");
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  });

  test("a download cannot escape the artifact directory through its file name", async () => {
    const workflow = await client.createWorkflow(
      `Download ostile ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      step({
        type: "download",
        name: "Scarica il file con nome ostile",
        selector: sel("id", "download-hostile-link")
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");

    const artifact = (execution.artifacts ?? []).find((a) => a.type === "download");
    expect(artifact, "the download must still be stored").toBeTruthy();

    // The property that matters: the file lives directly inside this execution's
    // own directory, so nothing the site puts in the name can move it elsewhere.
    // Playwright already replaces path separators in suggestedFilename(), so the
    // guard in the runner is defence in depth rather than the only barrier; the
    // raw hostile input is covered by apps/worker/src/runner/artifact-path.test.ts.
    const directory = artifact!.path.slice(0, artifact!.path.lastIndexOf("/"));
    expect(directory).toBe(`/data/artifacts/${started.id}`);
    expect(artifact!.path).not.toContain("/tmp/");
    expect(artifact!.path).not.toContain("/../");
  });

  test("refuses to act on a different page when the recorded one is not open", async () => {
    // The selector rules never guess; page selection must not either. A step
    // recorded on a tab that is not open at replay time would otherwise run
    // against whatever page happens to be active, clicking the wrong thing.
    const workflow = await client.createWorkflow(
      `Pagina mancante ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    const onMissingTab = step({
      type: "fill",
      name: "Scrivi in una tab mai aperta",
      value: "non deve finire sulla pagina principale",
      timeoutMs: 5000,
      pageId: "tab-7",
      selector: sel("id", "text-input", { pageId: "tab-7" })
    });

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      onMissingTab
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(execution.status).toBe("failed");
    expect(execution.failedStepId).toBe(onMissingTab.id);
    expect(execution.errorMessage).toContain("tab-7");
    // The message must help: it says which pages are actually open.
    expect(execution.errorMessage).toMatch(/main/);
  });

  test("fills a field inside a same-origin iframe", async () => {
    const workflow = await client.createWorkflow(
      `Iframe ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      step({
        type: "fill",
        name: "Inserisci nel frame",
        value: "testo dentro l'iframe",
        selector: sel("id", "frame-input", { frame: "#inner" })
      }),
      step({
        type: "click",
        name: "Clicca il bottone nel frame",
        selector: sel("id", "frame-button", { frame: "#inner" })
      }),
      step({
        type: "assertText",
        name: "Verifica risultato nel frame",
        value: "frame-clicked",
        selector: sel("testid", "frame-result", { frame: "#inner" })
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");
  });

  test("renders variables and credentials into step values at run time", async () => {
    await client.saveCredential("wizard_name", "Nome Da Variabile", "variable");
    await client.saveCredential("wizard_secret", "segreto-non-loggato", "secret");

    const workflow = await client.createWorkflow(
      `Template ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );

    await client.putSteps(workflow.id, [
      step({
        type: "goto",
        name: "Vai al wizard",
        value: `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
      }),
      step({
        type: "fill",
        name: "Inserisci Nome",
        value: "{{variables.wizard_name}}",
        selector: sel("label", "Nome", { fallback: "#fullname" })
      }),
      step({
        type: "fill",
        name: "Inserisci Email",
        value: "template@example.com",
        selector: sel("label", "Email", { fallback: "#wizard-email" })
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
        type: "fill",
        name: "Inserisci Note",
        value: "{{credentials.wizard_secret}}",
        selector: sel("label", "Note", { fallback: "#notes" })
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
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(
      execution.status,
      `execution failed: ${execution.errorMessage ?? ""}`
    ).toBe("completed");

    // The variable was rendered, and so was the secret.
    const state = await getTestWebState();
    const submission = state.wizardSubmissions.at(-1)!;
    expect(submission.name).toBe("Nome Da Variabile");
    expect(submission.notes).toBe("segreto-non-loggato");

    // The secret never appears in the logs or in the API response.
    const logs = (execution.logs ?? []).map((l) => l.message).join("\n");
    expect(logs).not.toContain("segreto-non-loggato");
    expect(JSON.stringify(execution)).not.toContain("segreto-non-loggato");
  });

  test("skips disabled steps", async () => {
    const workflow = await client.createWorkflow(
      `Step disabilitati ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );

    await client.putSteps(workflow.id, [
      step({
        type: "goto",
        name: "Vai al wizard",
        value: `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
      }),
      // This step would fail if it ran: the selector does not exist.
      step({
        type: "click",
        name: "Step disabilitato che fallirebbe",
        enabled: false,
        timeoutMs: 3000,
        selector: sel("id", "non-esiste")
      }),
      step({
        type: "assertVisible",
        name: "Verifica campo nome",
        selector: sel("id", "fullname")
      })
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);
    expect(execution.status).toBe("completed");

    // Only the two enabled steps were executed.
    const messages = (execution.logs ?? []).map((l) => l.message).join("\n");
    expect(messages).toContain("with 2 steps");
    expect(messages).not.toContain("Step disabilitato");
  });

  test("refuses to upload a file from outside the fixture directory", async () => {
    const workflow = await client.createWorkflow(
      `Upload non permesso ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/elements`
    );

    const upload = step({
      type: "upload",
      name: "Prova a caricare un file di sistema",
      value: "../../etc/passwd",
      timeoutMs: 5000,
      selector: sel("id", "upload")
    });

    await client.putSteps(workflow.id, [
      step({ type: "goto", name: "Vai agli elementi", value: `${TEST_WEB_INTERNAL_URL}/elements` }),
      upload
    ]);

    const started = await client.runNow(workflow.id);
    const execution = await client.waitForExecution(started.id);

    expect(execution.status).toBe("failed");
    expect(execution.failedStepId).toBe(upload.id);
    expect((await getTestWebState()).uploads).toHaveLength(0);
  });
});
