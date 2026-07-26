# Browser Automation MVP

Record, save, schedule and run browser automations. A user creates a workflow,
starts a remote Chromium visible in the browser through noVNC, navigates the
target site manually while the actions are recorded, turns them into editable
steps, and then runs the workflow immediately or schedules a single future run.

Everything runs in Docker. There are no external dependencies: the end-to-end
suite drives an internal fake application (`test-web`), never the public internet.

---

## Quick start

```bash
cp .env.example .env          # adjust the secrets before any real use
make up                       # build and start the stack
# open http://localhost:8080  and log in with the seeded user
```

Seeded user: `test@example.com` / `TestPassword123!`
(change it with `SEED_USER_EMAIL` / `SEED_USER_PASSWORD`).

Without `make`:

```bash
docker compose up -d --build
```

| Target | URL |
| --- | --- |
| Web UI | `http://localhost:8080` |
| API through the proxy | `http://localhost:8080/api` |
| Liveness / readiness | `http://localhost:8080/health`, `/ready` |

Postgres, Redis, the browser worker and the per-session VNC ports are **not**
published: they are only reachable on the internal Docker network.

---

## Verification

One command runs everything and exits non-zero if any check fails:

```bash
make verify        # or: pnpm verify
```

It performs, in order: dependency install, Prisma client generation, workspace
build, lint, type checking, unit tests, integration tests (against throwaway
Postgres and Redis), Docker image builds, start of the Docker test environment,
healthcheck wait, migration and seed verification, reachability checks, then the
end-to-end suites (stack, browser worker and noVNC, session isolation, recorder
and overlay, step editor, step types, main flow, stop-at-first-error, scheduling),
a production image build, and finally the teardown. A summary table is printed
with the result, exit code and test counts of every step.

Useful switches:

```bash
KEEP_STACK=1 make verify    # leave the test stack up for inspection
SKIP_DOCKER=1 make verify   # only the host-side checks
```

Individual pieces:

```bash
make lint typecheck test-unit
make test-integration       # starts and stops its own data stores
make test-up && make e2e    # test stack on :8081, then the e2e suite
```

Logs of the last verification run are kept in `.verify-logs/`.

### Minimum manual verification

The automated suite covers everything below, but this is the shortest path to
confirm the product by hand after a change:

1. `make up`, then wait until `docker compose ps` shows every service healthy.
2. `curl localhost:8080/ready` returns `{"status":"ready", ...}` with all three
   dependencies `ok`.
3. Open `http://localhost:8080`, log in with the seeded user.
4. Create a workflow with a public start URL, press **Avvia browser**: the remote
   Chromium appears in the page and the status line shows `noVNC: connected`.
5. Press **Registra**, interact with the site through the noVNC view: the
   interactive elements are outlined with the documented colours, and steps appear
   in the right-hand list as you act.
6. Press **Stop**, then **Salva**: the workflow status becomes `ready`.
7. Press **Esegui adesso**: the execution page streams the log live and ends in
   `completed`; the notifications page shows a success entry.
8. Break a selector on purpose and run again: the execution stops at that step,
   shows the error and the screenshot, and a failure notification appears.
9. Schedule a run one minute ahead and leave the page: the execution starts on
   its own and appears under *Esecuzioni*.
10. `make down` removes everything.

---

## Architecture

```
                    ┌──────────────┐
  browser  ───────► │ reverse-proxy│  nginx, the only published port
                    └──────┬───────┘
                     /api  │  /
              ┌────────────┴───────────┐
              ▼                        ▼
        ┌───────────┐            ┌───────────┐
        │    api    │            │    web    │  Next.js
        │  Fastify  │            └───────────┘
        └─────┬─────┘
   ┌──────────┼─────────────┬──────────────┐
   ▼          ▼             ▼              ▼
┌────────┐ ┌──────┐  ┌────────────┐  websocket proxy
│postgres│ │redis │  │   worker   │  ──► websockify ──► x11vnc ──► Xvfb ──► Chromium
└────────┘ └──────┘  └────────────┘
             BullMQ    Playwright
```

* **api** (Fastify) — REST API, authentication, ownership checks, the BullMQ
  producer, Server-Sent Events for live logs, and the authenticated WebSocket
  proxy that carries the noVNC stream.
* **worker** (Node + Playwright) — owns browser sessions and executes workflows.
  Per session it allocates a dedicated Xvfb display, an x11vnc server bound to
  loopback, a websockify port on the internal network, and a Chromium instance
  with its own temporary profile. It also consumes the BullMQ queue.
* **web** (Next.js) — login, dashboard, workflows, recorder with the noVNC view,
  step editor, variables and credentials, scheduling, executions, notifications.
* **test-web** — the internal fake application used by the tests.

### Repository layout

```
apps/
  api/        Fastify REST API + noVNC WebSocket proxy
  web/        Next.js frontend
  worker/     browser session manager, recorder and workflow runner
  test-web/   fake application used by the e2e suite
packages/
  database/        Prisma schema, migrations, seed, notification service
  shared/          crypto, JWT, templates, URL safety, logging, state machines
  workflow-schema/ step and selector schema, validation, action conversion
docker/
  api/ web/ browser/ test-web/   Dockerfiles
  nginx/                          reverse proxy configuration
e2e/            Playwright end-to-end suites
scripts/verify.sh
docker-compose.yml              development stack
docker-compose.test.yml         test stack, includes test-web
docker-compose.integration.yml  data stores for the integration tests
```

---

## How a workflow is built and run

1. **Create** a workflow with a name and a start URL.
2. **Start the browser**: the worker allocates a display and a VNC port and
   launches Chromium; the frontend connects to it with noVNC through the API.
3. **Record**: an injected script highlights interactive elements, shows a tooltip
   with the element details and the proposed selector, and reports every action.
   The worker converts actions into structured steps.
4. **Check**: every recorded step is verified against the live page as you record,
   using the same resolution the runner will use. Each step carries a badge —
   *verificato*, *selector ambiguo*, *non trovato* — and stopping the recording
   says how many steps are not replayable. A step whose page navigated away is
   reported as unverified rather than broken, so the check never cries wolf.
5. **Edit**: rename, change the selector or the value, reorder, delete, disable,
   add a wait or an assertion.
6. **Save**: steps are persisted; secrets captured during recording are stored
   encrypted and referenced as `{{credentials.name}}`.
7. **Run** immediately, or **schedule** a single future run.

### Step format

```json
{
  "id": "b2f1c0e4-2f8c-4a1f-9c1e-9a7b3d5e1f22",
  "type": "click",
  "name": "Clicca Continua",
  "pageId": "main",
  "selector": {
    "strategy": "role",
    "role": "button",
    "name": "Continua",
    "fallback": "button[type='submit']",
    "pageId": "main",
    "frame": null
  },
  "value": null,
  "timeoutMs": 10000,
  "enabled": true
}
```

Supported types: `goto`, `click`, `fill`, `select`, `check`, `uncheck`, `press`,
`wait`, `waitForElement`, `assertVisible`, `assertText`, `switchPage`, `download`,
`upload`.

### Selector strategy

Priority: `getByRole` → `getByLabel` → `getByPlaceholder` → `getByText` (only
when unique) → `data-testid` → `name` → `id` → CSS → XPath.

Before acting, the runner checks that the selector matches **exactly one**
element. If it matches none, the recorded raw fallback is tried; if it matches
several, the workflow **stops** — it never picks the first candidate. There is no
auto-healing.

### Variables and credentials

```
{{variables.customerName}}
{{credentials.email}}
{{credentials.password}}
```

A credential captured while recording is named after the field **and the site**
(`password_example_com`), so recording a login on a second site cannot overwrite
the first site's secret. Re-recording the same site updates it, which is what you
want when a password changes.

Both kinds are encrypted at rest with AES-256-GCM. Variable values can be read
back through the API; secret values never can. A `type="password"` field
automatically becomes a credential while recording, and the captured value is
persisted by the API without ever being sent to the browser. Secrets are stripped
from logs and error messages.

### Overlay colours

| Element | Colour |
| --- | --- |
| input, textarea | yellow |
| select | orange |
| checkbox, radio | purple |
| button | red |
| link | blue |
| non-standard clickable | green |
| disabled | grey |

The overlay is a single injected stylesheet that only sets `outline`, so it
cannot change the layout, block clicks or typing. It survives navigation and
applies to nodes added later by SPA code, and it can be toggled off.

### Error handling

At the first failing step the run stops: status `failed`, the failing step id,
the error message, the current URL, a screenshot artifact, the recent logs and an
in-app failure notification. No retries, no recovery, no resume.

---

## Security

* Session cookie (`httpOnly`, `sameSite=lax`) carrying a signed JWT.
* Every workflow, credential, execution, notification and browser session is
  scoped to its owner; another user's resource is reported as *not found*.
* Credentials encrypted with AES-256-GCM; secrets excluded from logs and API
  responses.
* User-supplied URLs are validated: only `http`/`https`, and localhost plus
  private ranges are blocked. The test environment enables them explicitly for
  `test-web` through `ALLOW_PRIVATE_TARGETS` / `ALLOWED_TARGET_HOSTS`.
* The noVNC stream requires **both** a valid app session and a short-lived token
  scoped to that one session and user. No VNC port is published; x11vnc listens
  on loopback only and websockify stays on the internal network.
* Browser sessions have a maximum lifetime and are cleaned up on close, timeout
  and crash (context, processes and temporary profile).
* Uploads can only use files from a fixed fixture directory inside the image.
* Rate limiting on the API, with tighter limits on login and registration.

---

## Environment variables

See `.env.example`. The ones that matter most:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | data store connections |
| `JWT_SECRET` | signs session and noVNC tokens |
| `CREDENTIALS_ENC_KEY` | AES key for credentials and variables |
| `SESSION_TOKEN_TTL_SECONDS` | lifetime of a noVNC token |
| `BROWSER_SESSION_TIMEOUT_MS` | maximum lifetime of a browser session |
| `WORKER_MAX_SESSIONS` | concurrent browser sessions per worker |
| `ALLOW_PRIVATE_TARGETS`, `ALLOWED_TARGET_HOSTS` | private-network exception |
| `PUBLIC_PORT` | published port of the reverse proxy |

**Change `JWT_SECRET` and `CREDENTIALS_ENC_KEY` before any real use.** Rotating
`CREDENTIALS_ENC_KEY` makes existing stored credentials undecryptable; there is
no key rotation in the MVP.

---

## Testing

* **Unit** (Vitest) — step validation, template rendering, credential
  encryption, selector generation, recorded-action conversion, state machines,
  schedule validation, URL safety, overlay colour mapping.
* **Integration** (Vitest against real Postgres and Redis) — auth, workflow and
  step persistence, credentials, browser-session API contract, BullMQ queue,
  scheduling, executions, artifacts, notifications, ownership isolation.
* **End-to-end** (Playwright against the Docker stack) — stack health and the
  absence of published data-store ports, the noVNC stream and its token scoping,
  session isolation, the recorder and the overlay colours in a real browser, the
  step editor, all fourteen step types, the main flow of section 18.3,
  stop-at-first-error, and scheduling including survival of a container restart.

`test-web` exposes a control API so tests are deterministic:

```
POST /api/test/reset        reset all state
POST /api/test/configure    delays, missing element, failing endpoint, login rejection
GET  /api/test/state        submitted data, uploads, login attempts
```

---

## Documented MVP limitations

* **A workflow modified after being scheduled runs with the state it has at
  start time.** There is no immutable workflow versioning: the scheduled job
  stores only the workflow id, so edits made before the run take effect. Version
  pinning is deliberately left for later.
* Only Chromium. Only linear workflows: no branches, conditions, loops,
  sub-workflows or parallel execution.
* Only one future run per schedule; no recurring schedules or cron.
* A run in progress can be cancelled, which stops it at the current step and
  releases its browser. There is no pause or resume.
* No automatic retries, no recovery, no resume from the failing step, no selector
  auto-healing.
* Cross-origin iframes are not supported; same-origin frames are.
* A recorded action whose element has no unique selector is **skipped** and
  reported instead of being guessed. The recorder counts them (`skipped`).
* A recorded `upload` step stores the file name, but the runner may only send
  files from the fixture directory baked into the worker image. A recorded upload
  therefore does not replay until that file is placed there.
* The recorder does not look inside shadow DOM, so elements rendered by web
  components are not detected.
* Notifications are in-app only. The provider interface is ready for external
  channels, but none is implemented.
* Sessions are isolated by browser context and temporary profile inside one
  worker container, not by one container per session.
* Live logs are delivered by SSE polling the log table every 500 ms, not by a
  pub/sub bus.
* Artifacts live on a Docker volume; there is no external object storage. They are
  removed when their workflow is deleted, but a run that is simply old keeps its
  screenshots forever: there is no retention policy.
* `WORKER_MAX_SESSIONS` bounds concurrency; there is no queue for browser
  sessions, so a request beyond the limit is refused.

### Deliberate deviation from the specified data model

The specification requires both plain variables and secret credentials
(section 8) but defines a single `Credential` table (section 14). A `kind` column
(`variable` | `secret`) was added to that table rather than overloading the name
field. Everything else follows the specified model, and workflow versioning is
not implemented.

---

## Future work

Not implemented, and intentionally out of scope for this MVP:

* Immutable workflow versioning, so a scheduled run always replays the exact
  version that was scheduled.
* Recurring schedules, cron expressions, calendars, time windows, job
  dependencies and priorities.
* Conditional steps, loops, branches, sub-workflows, parallel execution.
* Configurable retries, recovery, resume from the failing step, selector
  auto-healing and stability scoring.
* External notification providers: email, chat, webhooks, push.
* Browsers other than Chromium; cross-origin iframe support.
* One container per browser session, and horizontal scaling of the worker pool.
* External secret managers and key rotation.
* OTP, CAPTCHA, WebAuthn and passkey flows.
* Organisations, teams, roles, invitations, billing.
* Analytics, metrics backends, distributed tracing, dashboards.
* External object storage for artifacts.
* Arbitrary JavaScript steps, computed variables and data transformations.
