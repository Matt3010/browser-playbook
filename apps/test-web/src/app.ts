import { randomUUID } from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { page, escapeHtml } from "./layout";
import {
  configure,
  getState,
  resetState,
  VALID_EMAIL,
  VALID_PASSWORD,
  type TestConfig
} from "./state";

const SESSION_COOKIE = "test_web_session";

export async function buildTestWeb(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "warn" }
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 } });

  function isLoggedIn(request: { cookies: Record<string, string | undefined> }): boolean {
    return Boolean(request.cookies[SESSION_COOKIE]);
  }

  // ---- health -------------------------------------------------------------

  app.get("/health", async () => ({ status: "ok", service: "test-web" }));
  app.get("/ready", async () => ({ status: "ready" }));

  // ---- test control API ---------------------------------------------------

  app.post("/api/test/reset", async () => {
    resetState();
    return { ok: true, config: getState().config };
  });

  app.post("/api/test/configure", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Partial<TestConfig> = {};

    const numbers: Array<keyof TestConfig> = [
      "dashboardDelayMs",
      "delayedButtonMs",
      "checkoutDelayMs",
      "navigationDelayMs"
    ];
    for (const key of numbers) {
      if (key in body) {
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < 0 || value > 60_000) {
          return reply.code(400).send({ error: `${key} must be between 0 and 60000` });
        }
        (patch as Record<string, unknown>)[key] = value;
      }
    }
    const booleans: Array<keyof TestConfig> = ["missingElement", "failApi", "rejectLogin"];
    for (const key of booleans) {
      if (key in body) {
        if (typeof body[key] !== "boolean") {
          return reply.code(400).send({ error: `${key} must be a boolean` });
        }
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }
    return { ok: true, config: configure(patch) };
  });

  app.get("/api/test/state", async () => {
    const state = getState();
    return {
      config: state.config,
      wizardSubmissions: state.wizardSubmissions,
      uploads: state.uploads,
      orders: state.orders,
      loginAttempts: state.loginAttempts,
      panelClicks: state.panelClicks
    };
  });

  // ---- 17.1 login ---------------------------------------------------------

  function loginPage(error?: string): string {
    return page(
      "Login - test-web",
      `
<h1>Accedi</h1>
${error ? `<p class="error" data-testid="login-error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>

  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>

  <div class="checkbox-row">
    <input id="remember" name="remember" type="checkbox" value="1">
    <label for="remember">Ricordami</label>
  </div>

  <button type="submit">Login</button>
</form>`
    );
  }

  app.get("/login", async (_request, reply) => reply.type("text/html").send(loginPage()));

  app.post("/login", async (request, reply) => {
    const state = getState();
    state.loginAttempts += 1;
    const body = (request.body ?? {}) as { email?: string; password?: string };

    const ok =
      !state.config.rejectLogin &&
      body.email === VALID_EMAIL &&
      body.password === VALID_PASSWORD;

    if (!ok) {
      return reply.code(401).type("text/html").send(loginPage("Credenziali errate"));
    }
    return reply
      .setCookie(SESSION_COOKIE, randomUUID(), { path: "/", httpOnly: true })
      .redirect("/dashboard");
  });

  app.post("/logout", async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: "/" }).redirect("/login")
  );

  // ---- 17.2 dashboard -----------------------------------------------------

  app.get("/dashboard", async (request, reply) => {
    if (!isLoggedIn(request)) return reply.redirect("/login");
    const delay = getState().config.dashboardDelayMs;

    return reply.type("text/html").send(
      page(
        "Dashboard - test-web",
        `
<h1>Benvenuto</h1>
<p data-testid="welcome">Benvenuto nella dashboard di test.</p>
<nav>
  <a href="/wizard/step-1" data-testid="link-wizard">Form multipagina</a>
  <a href="/elements" data-testid="link-elements">Pagina elementi</a>
</nav>
<p id="late-element" data-testid="late-element" hidden>Contenuto caricato in ritardo</p>
<form method="post" action="/logout"><button type="submit">Logout</button></form>
<script>
  setTimeout(function () {
    var el = document.getElementById("late-element");
    el.hidden = false;
    el.setAttribute("data-loaded", "true");
  }, ${delay});
</script>`
      )
    );
  });

  // ---- 17.3 multipage wizard ---------------------------------------------

  app.get("/wizard/step-1", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Wizard 1 - test-web",
        `
<h1>Step 1 di 2</h1>
<form method="post" action="/wizard/step-1">
  <label for="fullname">Nome</label>
  <input id="fullname" name="name" type="text" required>

  <label for="wizard-email">Email</label>
  <input id="wizard-email" name="email" type="email" required>

  <button type="submit">Continua</button>
</form>`
      )
    )
  );

  app.post("/wizard/step-1", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; email?: string };
    const draftId = request.cookies[SESSION_COOKIE] ?? randomUUID();
    getState().wizardDrafts[draftId] = {
      name: body.name ?? "",
      email: body.email ?? ""
    };
    return reply
      .setCookie(SESSION_COOKIE, draftId, { path: "/", httpOnly: true })
      .redirect("/wizard/step-2");
  });

  app.get("/wizard/step-2", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Wizard 2 - test-web",
        `
<h1>Step 2 di 2</h1>
<form method="post" action="/wizard/step-2">
  <label for="plan">Piano</label>
  <select id="plan" name="plan">
    <option value="">Scegli...</option>
    <option value="base">Base</option>
    <option value="pro">Pro</option>
    <option value="enterprise">Enterprise</option>
  </select>

  <div class="checkbox-row">
    <input id="newsletter" name="newsletter" type="checkbox" value="1">
    <label for="newsletter">Iscrivimi alla newsletter</label>
  </div>

  <label for="notes">Note</label>
  <textarea id="notes" name="notes"></textarea>

  <button type="submit">Completa</button>
</form>`
      )
    )
  );

  app.post("/wizard/step-2", async (request, reply) => {
    const body = (request.body ?? {}) as {
      plan?: string;
      newsletter?: string;
      notes?: string;
    };
    const state = getState();
    const draftId = request.cookies[SESSION_COOKIE] ?? "";
    const draft = state.wizardDrafts[draftId] ?? { name: "", email: "" };

    state.wizardSubmissions.push({
      name: draft.name,
      email: draft.email,
      plan: body.plan ?? "",
      newsletter: body.newsletter === "1",
      notes: body.notes ?? "",
      submittedAt: new Date().toISOString()
    });
    delete state.wizardDrafts[draftId];
    return reply.redirect("/wizard/complete");
  });

  app.get("/wizard/complete", async (_request, reply) => {
    const submissions = getState().wizardSubmissions;
    const last = submissions[submissions.length - 1];

    const summary = last
      ? `<dl data-testid="summary">
  <dt>Nome</dt><dd data-testid="summary-name">${escapeHtml(last.name)}</dd>
  <dt>Email</dt><dd data-testid="summary-email">${escapeHtml(last.email)}</dd>
  <dt>Piano</dt><dd data-testid="summary-plan">${escapeHtml(last.plan)}</dd>
  <dt>Newsletter</dt><dd data-testid="summary-newsletter">${last.newsletter ? "si" : "no"}</dd>
  <dt>Note</dt><dd data-testid="summary-notes">${escapeHtml(last.notes)}</dd>
</dl>`
      : `<p data-testid="summary-empty">Nessun invio registrato.</p>`;

    return reply.type("text/html").send(
      page(
        "Wizard completato - test-web",
        `<h1>Completato</h1>
<p data-testid="complete-message">Form inviato correttamente.</p>
${summary}`
      )
    );
  });

  // ---- 17.4 interactive elements -----------------------------------------

  app.get("/elements", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Elementi - test-web",
        `
<h1>Elementi interattivi</h1>

<label for="text-input">Campo testo</label>
<input id="text-input" name="textField" type="text" placeholder="Scrivi qui">

<label for="area">Area di testo</label>
<textarea id="area" name="areaField" placeholder="Note libere"></textarea>

<label for="choice">Selezione</label>
<select id="choice" name="choiceField">
  <option value="a">Opzione A</option>
  <option value="b">Opzione B</option>
</select>

<div class="checkbox-row">
  <input id="accept" name="accept" type="checkbox" value="1">
  <label for="accept">Accetto i termini</label>
</div>

<fieldset>
  <legend>Spedizione</legend>
  <div class="checkbox-row">
    <input id="ship-standard" name="shipping" type="radio" value="standard" checked>
    <label for="ship-standard">Standard</label>
  </div>
  <div class="checkbox-row">
    <input id="ship-express" name="shipping" type="radio" value="express">
    <label for="ship-express">Express</label>
  </div>
</fieldset>

<div class="row">
  <button id="real-button" type="button" onclick="document.getElementById('clicked').textContent='clicked'">Bottone reale</button>
  <span id="clicked" data-testid="clicked"></span>
</div>

<div class="row">
  <a id="internal-link" href="/dashboard">Vai alla dashboard</a>
  <a id="new-tab-link" href="/elements/popup" target="_blank" rel="noopener">Apri nuova tab</a>
</div>

<div class="row">
  <div id="fake-button" role="button" tabindex="0"
       onclick="document.getElementById('fake-clicked').textContent='fake-clicked'"
       style="padding:.6rem 1.1rem;background:#e8ebf0;border-radius:6px;cursor:pointer">
    Elemento con role=button
  </div>
  <span id="fake-clicked" data-testid="fake-clicked"></span>
</div>

<div class="row">
  <button id="disabled-button" type="button" disabled>Bottone disabilitato</button>
  <input id="disabled-input" type="text" value="non modificabile" disabled>
</div>

<!--
  A required field marked the way real applications mark one: an asterisk that is
  drawn on screen but hidden from the accessibility tree. It is not part of the
  accessible name, so a recorder that reads the label's raw text records a name
  that matches nothing on replay.
-->
<div class="row">
  <label for="required-field">Codice cliente <span aria-hidden="true">*</span></label>
  <input id="required-field" name="clientCode" type="text">
</div>

<fieldset>
  <legend>Taglia (input coperto dalla propria label)</legend>
  <!--
    Reproduces the pattern used by many real storefronts: the radio input is
    visually hidden underneath a styled label, so a click always lands on the
    label and never on the input itself. The label text also embeds volatile
    content (a price), which must not end up in the recorded selector.
  -->
  <div class="covered-choice">
    <input id="_r_a_" type="radio" name="size-choice" value="13inch" checked
           aria-labelledby="_r_a_label">
    <label for="_r_a_" id="_r_a_label" class="covering-label">
      <span><span>13"</span> <span>Da &euro; 1.249,00 o &euro; 41,63 al mese per 36 mesi, TAN fisso 10,99%</span></span>
    </label>
  </div>
  <div class="covered-choice">
    <input id="_r_b_" type="radio" name="size-choice" value="15inch"
           aria-labelledby="_r_b_label">
    <label for="_r_b_" id="_r_b_label" class="covering-label">
      <span><span>15"</span> <span>Da &euro; 1.749,00 o &euro; 57,26 al mese per 36 mesi, TAN fisso 10,99%</span></span>
    </label>
  </div>
  <p>Scelta: <span id="size-result" data-testid="size-result">13inch</span></p>
</fieldset>
<script>
  document.querySelectorAll('input[name="size-choice"]').forEach(function (input) {
    input.addEventListener("change", function () {
      if (input.checked) {
        document.getElementById("size-result").textContent = input.value;
      }
    });
  });
</script>

<form method="post" action="/elements/upload" enctype="multipart/form-data">
  <label for="upload">Carica un file</label>
  <input id="upload" name="file" type="file">
  <button type="submit">Invia file</button>
</form>

<p><a class="btn" id="download-link" href="/elements/download" download>Scarica file</a></p>
<p><a class="btn" id="download-hostile-link" href="/elements/download-hostile" download>Scarica file con nome ostile</a></p>

<fieldset>
  <legend>Radio controllato dal framework</legend>
  <!--
    Reproduces what a real storefront does with a component framework: the input
    does not own its state, so the browser's own toggle is suppressed and only the
    label's handler changes the selection. Clicking the hidden input directly,
    even bypassing the overlay check, leaves it unchanged.
  -->
  <div class="covered-choice">
    <input id="ctrl-13" type="radio" name="controlled-size" value="13inch" checked
           onclick="event.preventDefault()">
    <label for="ctrl-13" class="covering-label" onclick="selectControlled('13inch')">
      <span>13" controllato</span>
    </label>
  </div>
  <div class="covered-choice">
    <input id="ctrl-15" type="radio" name="controlled-size" value="15inch"
           onclick="event.preventDefault()">
    <label for="ctrl-15" class="covering-label" onclick="selectControlled('15inch')">
      <span>15" controllato</span>
    </label>
  </div>
  <p>Scelta controllata: <span id="controlled-result" data-testid="controlled-result">13inch</span></p>
</fieldset>
<script>
  function selectControlled(value) {
    document.querySelectorAll('input[name="controlled-size"]').forEach(function (input) {
      input.checked = input.value === value;
    });
    document.getElementById("controlled-result").textContent = value;
  }
</script>

<fieldset>
  <legend>Elemento che la pagina duplica dopo il click</legend>
  <!--
    Lists that re-render, "add another" controls and infinite scrolls all do this:
    the element the recorder saw as unique has an identical twin a moment later.
    The selector recorded is then ambiguous, and only checking it against the page
    after the interaction can reveal it.
  -->
  <div id="clone-target-area">
    <button class="clone-me" type="button" onclick="cloneMe(this)">Aggiungi riga</button>
  </div>
</fieldset>
<script>
  function cloneMe(button) {
    var copy = button.cloneNode(true);
    document.getElementById("clone-target-area").appendChild(copy);
  }
</script>

<h2>Iframe same-origin</h2>
<iframe id="inner" title="Contenuto interno" src="/elements/frame"></iframe>`
      )
    )
  );

  app.get("/elements/frame", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Frame - test-web",
        `<h1>Dentro l'iframe</h1>
<label for="frame-input">Campo nel frame</label>
<input id="frame-input" name="frameField" type="text" placeholder="Testo nel frame">
<button id="frame-button" type="button"
        onclick="document.getElementById('frame-result').textContent='frame-clicked'">
  Bottone nel frame
</button>
<p id="frame-result" data-testid="frame-result"></p>`
      )
    )
  );

  app.get("/elements/popup", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Nuova tab - test-web",
        `<h1>Nuova tab</h1>
<p data-testid="popup-message">Questa pagina è stata aperta in una nuova tab.</p>
<label for="popup-input">Campo nella nuova tab</label>
<input id="popup-input" name="popupField" type="text">`
      )
    )
  );

  app.post("/api/test/panel-click", async (request) => {
    const body = (request.body ?? {}) as { origin?: unknown };
    getState().panelClicks.push({
      origin: typeof body.origin === "string" ? body.origin : "unknown",
      at: new Date().toISOString()
    });
    return { ok: true };
  });

  /*
    Page ids are handed out in the order tabs appear, so `tab-1` means "the first tab
    that opened", not "that tab". This page opens an unexpected tab before the one the
    workflow cares about — an ad, an interstitial, a session warning: something real
    sites do and recording sessions often miss. The intruder is the very same panel
    served on the other origin the stack answers on, so a selector recorded for the
    real panel resolves there too and the wrong document accepts the action in
    silence.
  */
  app.get("/tabs/intruder", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Tab inattesa - test-web",
        `<h1>Pannello ordini</h1>
<p>Questa pagina apre una tab inattesa prima di quella che serve.</p>
<button id="open-panel" onclick="window.open('/tabs/panel', '_blank')">Apri il pannello</button>
<script>
  // Fires before anything the workflow does, so it takes tab-1.
  window.open("http://shop-web:3001/tabs/panel", "_blank");
</script>`
      )
    )
  );

  /*
    The harder half of the same problem: a popup opened with a bare window.open() has
    no URL, so it stays about:blank at run time too and the origin of the tab that
    took its number says nothing. The panel is written into it by script, exactly as
    older payment and confirmation popups do.
  */
  app.get("/tabs/blank", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Popup vuoto - test-web",
        `<h1>Pannello senza URL</h1>
<button id="open-blank" onclick="openPanel()">Apri il pannello</button>
<script>
  // The panel is built by the opener inside a popup that has no address of its own,
  // the way older payment and confirmation popups do. The click reports which panel
  // it was through the opener's own fetch, so telling them apart needs no CORS.
  function buildPanel(win, label) {
    var doc = win.document;
    var button = doc.createElement("button");
    button.id = "panel-action";
    button.textContent = "Conferma dal pannello";
    button.addEventListener("click", function () {
      fetch("/api/test/panel-click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: label })
      });
    });
    (doc.body || doc.documentElement).appendChild(button);
  }
  function openPanel() {
    buildPanel(window.open("", "_blank"), location.origin);
  }
  // Runs before anything the workflow does, so it takes tab-1 — and it is blank, so
  // nothing about its address tells it apart from the real one.
  buildPanel(window.open("", "_blank"), "intruder");
</script>`
      )
    )
  );

  app.get("/tabs/panel", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Pannello - test-web",
        `<h1>Pannello</h1>
<p data-testid="panel-origin"></p>
<button id="panel-action" onclick="confirmPanel()">Conferma dal pannello</button>
<script>
  document.querySelector('[data-testid="panel-origin"]').textContent = location.origin;
  function confirmPanel() {
    fetch("/api/test/panel-click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: location.origin })
    });
  }
</script>`
      )
    )
  );

  app.get("/elements/download", async (_request, reply) =>
    reply
      .header("content-disposition", 'attachment; filename="sample.txt"')
      .type("text/plain")
      .send("contenuto-file-di-test\n")
  );

  /**
   * Serves a download whose Content-Disposition tries to climb out of the
   * directory the worker stores artifacts in. A site can always do this, so the
   * runner must never build a path from this name.
   */
  app.get("/elements/download-hostile", async (_request, reply) =>
    reply
      .header(
        "content-disposition",
        'attachment; filename="../../../../tmp/pwned-by-download.txt"'
      )
      .type("text/plain")
      .send("payload\n")
  );

  app.post("/elements/upload", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).type("text/html").send(page("Upload", "<h1>Nessun file</h1>"));
    }
    const buffer = await file.toBuffer();
    getState().uploads.push({
      filename: file.filename,
      size: buffer.length,
      content: buffer.toString("utf8").slice(0, 500)
    });
    return reply.type("text/html").send(
      page(
        "Upload completato - test-web",
        `<h1>File ricevuto</h1>
<p data-testid="upload-filename">${escapeHtml(file.filename)}</p>
<p data-testid="upload-size">${buffer.length}</p>`
      )
    );
  });

  // ---- 17.5 controlled errors --------------------------------------------

  app.get("/errors", async (_request, reply) => {
    const config = getState().config;

    const confirmButton = config.missingElement
      ? `<p data-testid="confirm-missing">Il pulsante Conferma non è disponibile.</p>`
      : `<button id="confirm-button" type="button"
             onclick="document.getElementById('confirm-result').textContent='confermato'">
      Conferma
    </button>
    <span id="confirm-result" data-testid="confirm-result"></span>`;

    return reply.type("text/html").send(
      page(
        "Errori - test-web",
        `
<h1>Errori controllati</h1>

<h2>Pulsante ritardato</h2>
<div id="delayed-container">
  <p data-testid="delayed-pending">In attesa...</p>
</div>

<h2>Pulsante che può mancare</h2>
${confirmButton}

<h2>Endpoint che può fallire</h2>
<button id="call-api" type="button" onclick="callApi()">Chiama API</button>
<p id="api-result" data-testid="api-result"></p>

<h2>Errore JavaScript</h2>
<button id="js-error" type="button" onclick="window.__missingFunction()">Genera errore JS</button>

<script>
  setTimeout(function () {
    var container = document.getElementById("delayed-container");
    container.innerHTML =
      '<button id="delayed-button" type="button" ' +
      'onclick="document.getElementById(\\'delayed-result\\').textContent=\\'ok\\'">' +
      'Pulsante ritardato</button>' +
      '<span id="delayed-result" data-testid="delayed-result"></span>';
  }, ${config.delayedButtonMs});

  function callApi() {
    fetch("/api/flaky")
      .then(function (r) {
        document.getElementById("api-result").textContent = "status:" + r.status;
      })
      .catch(function (e) {
        document.getElementById("api-result").textContent = "error:" + e.message;
      });
  }
</script>`
      )
    );
  });

  // ---- a link whose destination is slow to answer ---------------------------

  /**
   * The navigation a click causes does not commit with the click: on a real site
   * it lands seconds later. A recorder that decides "this navigation belongs to
   * that click" by how quickly it arrived gets it wrong on every slow site.
   */
  app.get("/slow-link", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Link lento - test-web",
        `<h1>Link lento</h1>
<a id="slow-link" href="/slow-target">Vai alla destinazione lenta</a>`
      )
    )
  );

  app.get("/slow-target", async (_request, reply) => {
    const delay = getState().config.navigationDelayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return reply.type("text/html").send(
      page(
        "Destinazione - test-web",
        `<h1>Destinazione</h1><p data-testid="slow-arrived">Arrivato.</p>`
      )
    );
  });

  // ---- destructive action, used to verify the closing-action capture --------

  app.get("/checkout", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Checkout - test-web",
        `<h1>Conferma ordine</h1>
<p>Ordini registrati: <span id="order-count" data-testid="order-count">${
          getState().orders.length
        }</span></p>
<form id="checkout-form" method="post" action="/checkout">
  <label for="order-note">Note per il corriere</label>
  <input id="order-note" name="note" type="text">
  <button id="place-order" type="submit">Acquista ora</button>
</form>
<script>
  // The order is sent by the page itself, the way a modern application does.
  // A classic form submit is a navigation, and Playwright waits for it as part
  // of the click; this is the case nothing waits for, so it is the case that
  // tells whether the runner is still there when the action lands.
  document.getElementById("checkout-form").addEventListener("submit", function (event) {
    event.preventDefault();
    fetch("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: document.getElementById("order-note").value })
    }).then(function () {
      window.location.href = "/checkout/confirmed";
    });
  });
</script>`
      )
    )
  );

  app.post("/checkout", async (request) => {
    const body = (request.body ?? {}) as { note?: string };
    // Answering the order takes as long as the test says it does: a destructive
    // action on a real site lands after the click, not with it.
    const delay = getState().config.checkoutDelayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    getState().orders.push({ note: body.note ?? "", placedAt: new Date().toISOString() });
    return { ok: true };
  });

  app.get("/checkout/confirmed", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Ordine effettuato - test-web",
        `<h1>Ordine effettuato</h1>
<p data-testid="order-confirmed">Grazie, il tuo ordine e stato registrato.</p>`
      )
    )
  );

  /**
   * Navigates itself away as soon as it loads. Real sites do this (geo/locale
   * redirects, consent walls), and it makes Playwright's `goto` fail with
   * "interrupted by another navigation" unless the runner tolerates it.
   */
  app.get("/redirecting", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Redirect - test-web",
        `<h1>Un attimo...</h1>
<script>window.location.replace("/elements");</script>`
      )
    )
  );

  app.get("/api/flaky", async (_request, reply) => {
    if (getState().config.failApi) {
      return reply.code(500).send({ error: "Errore interno simulato" });
    }
    return { ok: true };
  });

  app.get("/", async (_request, reply) => reply.redirect("/login"));

  return app;
}
