# CLAUDE.md

Working notes for this repository. Read before changing anything.

## Current standing goal: find and fix as many real bugs as possible

The MVP is feature-complete and deployed. The work now is **hardening**: hunt
defects in the existing implementation rather than add features.

**Test first, then fix. Always, without exception.**

For every suspected defect:

1. **Write a failing test that reproduces it.** Unit test when the logic is pure,
   integration test when it needs Postgres/Redis, e2e when it needs a real browser.
   Run it and *watch it fail* — a test that passes before the fix proves nothing.
2. **Fix the production code**, never the test, to make it pass.
3. **Re-run the failing test**, then **the whole suite** (`make verify`), to catch
   regressions. Fixing the one test is not enough.
4. If the reproduction turns out to be wrong, say so and delete it. Do not keep a
   test that asserts the wrong thing just because it is green.

Never weaken an assertion, add a `skip`, widen a timeout or delete a case to make
the suite green. If a test is genuinely wrong, explain why before changing it.

### Where bugs have already been found

These are the classes of defect this codebase actually produced, so look here first:

- **Zod schemas silently dropping fields.** `ElementInfoSchema` did not declare
  `valueAttr`, so the recorder's data was stripped on the way in and every radio
  selector degraded to a structural CSS path. Any field added to the browser
  script must also be added to the schema, with a test asserting it survives.
- **Session lifetime and cleanup.** A recorder session abandoned by closing the
  tab used to hold its slot until the maximum lifetime expired, blocking new
  sessions. Executions clean up in a `finally`; UI sessions rely on the idle
  reaper. Check both paths when touching session code.
- **Cross-process assumptions on real sites.** Playwright refuses to click an
  element covered by another one (a hidden radio under its styled label). Selector
  *resolution* succeeding does not mean the *action* will succeed.
- **Volatile selector values.** Labels embedding prices or percentages produce
  selectors that work when recorded and break at the next price change.
- **Framework-generated ids** (`_r_e_`, `:r0:`, `mui-1234`) are useless in a saved
  workflow.
- **WebSocket close codes.** Forwarding a reserved code (1006) makes `ws` throw and
  killed the API process.
- **Environment leaking between compose files.** A local `.env` defining
  `PUBLIC_PORT` silently moved the test stack onto the development port. Test
  infrastructure must use its own variables (`TEST_PUBLIC_PORT`).
- **Test races.** Reading server state right after clicking Save raced the request.
  Wait for an observable effect, never a bare sleep.
- **Reserved behaviour of the reaper.** Polling a session by id counts as driving
  it, so a test that polls `/sessions/:id` can never observe the idle timeout. Use
  the list endpoint.
- **Validating the request instead of the result.** `goto` checked the requested
  URL, but a page may redirect the browser anywhere, including an internal
  address whose response is then visible over noVNC. Where a navigation *lands*
  is now re-checked. The same reasoning applies elsewhere: validate the outcome,
  not only the input.
- **Validating before defaults are applied.** Closing-action placement was decided
  on the raw payload, where an omitted `enabled` looked like `false`. Parse first,
  validate second.
- **Creating a row before the side effect can fail.** An execution row was written
  and only then enqueued; a queue failure left it `queued` forever. Every route
  that writes a row and then performs a fallible action must close the row on failure.
- **One Dockerfile declared by two services** produced two images that drifted, so
  a new migration was silently never applied. Services that must share code share
  the `image:` tag.
- **Suites sharing a database in parallel.** Recursive pnpm scripts run in
  parallel by default; two suites truncating one database made failures look random.
- **Nothing closes work whose owner died.** Only the worker advances an execution,
  so one left `running` when the worker was killed stayed "in progress" forever.
  Reconcile in-flight state at startup, as `reconcileOrphanedExecutions` does.
- **Library defaults that retry.** BullMQ replays a *stalled* job by default,
  independently of `attempts`. For this product that means replaying a workflow
  that already acted on the target site, so `maxStalledCount: 0` is deliberate.
  Check what a dependency does on failure, not only on success.
- **Guessing anywhere, not just on selectors.** The selector rules stop on
  ambiguity, but page selection silently fell back to whatever page was active
  when the recorded one was not open — running the action against the wrong
  document and reporting success. Every "which one do I act on" decision needs
  the same rule: resolve exactly, or stop.
- **Prefix checks without a separator.** `startsWith(root)` accepts a sibling
  directory that shares the prefix (`<root>-evil`) and the root itself. Always
  `startsWith(root + path.sep)`.
- **PID 1 in a container reaps nothing.** Chromium re-parents children to the
  worker process, and Node only reaps what it spawned, so every session left a
  few zombies. Services that spawn foreign process trees need `init: true`.
- **Files outlive their rows.** Cascading deletes clear the database and leave the
  volume untouched; artifacts had to be removed explicitly, restricted to the
  artifact root.
- **`force` bypasses the check, not the cause.** Playwright's `force: true` skips
  the hit-target test and still aims at the same element, so it does nothing for an
  input whose state the page's own code owns: the click lands, the state does not
  move, and the failure reads "did not change its state". Do what a person does —
  click the controlling label — and keep `force` for covered elements that have no
  label. Coverage is asked up front (`document.elementFromPoint` on the element's
  own centre) rather than inferred from an expired timeout, which used to cost the
  whole step timeout per covered control. Going through the label costs idempotence,
  so `check`/`uncheck` read the state before acting and read it again afterwards:
  a label click that moved nothing must never pass for success.
- **The same decision made twice drifts.** The recorder's tooltip and "selected
  element" panel computed their proposed selector with a second implementation
  living inside the injected script, which never learned the rules added later, so
  the UI promised `getByRole(... '15" € 1.749,00 ...')` while the recorder stored a
  stable selector. The injected script cannot import, but it can *ask*:
  `exposeBinding` returns a promise to the page, so the choice is made once by
  `chooseSelector` and rendered by `formatSelectorAsCode`.
- **Two paths onto the same page must handle it the same way.** `withOverlayFallback`
  taught the runner to click a covering label, but `session.interact()` — the
  endpoint the recorder UI drives the page with — still called `locator.check()`
  raw, so a covered radio failed with a 500 while the identical step replayed fine.
  Pointer delivery now lives in `runner/pointer-action.ts` and both use it. A
  control that can be recorded must be replayable, and the reverse.
- **Nothing stopped a workflow running twice at once.** Two clicks on the run
  button, or a schedule coming due during a manual run, created a second execution
  and the site was acted on twice. The worker's `concurrency: 1` does not help — it
  serialises them rather than refusing. The route now refuses with 409 when an
  execution is `queued`/`starting`/`running`, excluding the `queued` row a future
  schedule reserves when it is created, which otherwise makes a scheduled workflow
  impossible to run by hand.
- **A check made when the schedule was created is stale when it fires.** The API
  refuses a workflow referencing a missing credential, but that was hours or days
  earlier: the credential can be gone by 3am. The runner re-checks before opening a
  browser, so nothing is touched at all. Any check whose inputs can change between
  acceptance and execution has to be repeated at execution.
- **Anything a renderer does not recognise it passes through.** `renderTemplate`
  substitutes `{{credentials.x}}` and `{{variables.x}}` and leaves everything else
  alone, so a mistyped `{{secret.password}}` was typed into the password field as
  literal text — a failed login every run, and enough of them lock the account.
  Worse, `value.includes("{{")` was used to *skip* the `goto` URL and `wait`
  duration checks. `StepSchema` now refuses a placeholder that is not a reference.
- **A shared image drags its healthcheck along.** `migrate` was given the api image
  to avoid a second build, and inherited a healthcheck probing port 4000, which
  nothing serves there. It exits 0 but never turns healthy, so every service
  waiting on `service_completed_successfully` hangs and the stack never comes up.
  A one-shot service that reuses a server image must set `healthcheck: disable:
  true`.

### Things a test cannot pin down

Some behaviour depends on browser timing and must not be asserted in e2e:
whether a self-redirect lands before or after `domcontentloaded`, and therefore
whether `goto` reports "interrupted by another navigation". Assert the outcome in
e2e and cover the branch itself with unit tests
(`apps/worker/src/runner/navigation.test.ts`).

## Verification

`make verify` (or `pnpm verify`) is the single gate. It must exit 0.
It runs: install, prisma generate, build, lint, typecheck, unit tests, integration
tests against throwaway Postgres/Redis, Docker image builds, the test stack with
healthchecks, migration and seed assertions, then every e2e suite, then a
production image build, then teardown. Logs land in `.verify-logs/`.

Useful during development:

```bash
KEEP_STACK=1 make verify        # leave the test stack up afterwards
SKIP_DOCKER=1 make verify       # host-side checks only
make test-up && make e2e        # test stack on :8081, then e2e
pnpm exec playwright test -c e2e/playwright.config.ts e2e/specs/<file>
```

## Layout and conventions

- `apps/api` Fastify REST API, the BullMQ producer, SSE live logs, the
  authenticated noVNC WebSocket proxy.
- `apps/worker` browser session manager (Xvfb + x11vnc + websockify + Chromium per
  session), the injected recorder, the step runner, the BullMQ consumer.
- `apps/web` Next.js frontend. `apps/test-web` the fake app the e2e suite drives.
- `packages/workflow-schema` step and selector schema, validation, conversion of
  recorded actions into steps. **Pure and fully unit-testable — put logic here
  rather than in the worker whenever possible.**
- `packages/shared` crypto, JWT, templates, URL safety, logging, state machines.
- `packages/database` Prisma schema, migrations, seed, notification service.

Rules that matter:

- The injected browser script (`apps/worker/src/recorder/browser-script.ts`) is
  serialised and evaluated in the page. It must stay **self-contained**: no
  imports, no references to anything outside its single argument. Data it needs
  (the overlay CSS) is computed in Node and passed in, which also makes it testable.
- Secrets never leave the server. Credential values are returned to the browser
  only for `kind: "variable"`, never for `kind: "secret"`.
- A selector must match exactly one element. Ambiguous means stop the workflow;
  never pick the first match. There is no auto-healing.
- Stop at the first failing step. No retries, no resume.
- Ports: only the reverse proxy is published. Postgres, Redis, the worker and the
  per-session VNC ports stay internal, and the e2e suite asserts this.

## Deployment

Raspberry Pi (`ssh rpi`, aarch64, Debian 13, 4 cores, 3.7 GB RAM, no swap),
repo at `~/apps/browser-playbook`, served on port 8080.

```bash
ssh rpi 'cd ~/apps/browser-playbook && git pull && docker compose up -d --build'
```

Notes specific to that host:

- `WORKER_MAX_SESSIONS=2` — one live Chromium leaves roughly 2 GB free. Do not raise it.
- The Playwright base image ships Node 20, but pnpm 11 needs Node >= 22.13, so the
  browser image installs Node 22 from NodeSource.
- Next.js `output: standalone` is gated behind `NEXT_STANDALONE=1` because creating
  symlinks fails for an unprivileged user on Windows.
- `.env` on the host holds generated secrets and is never committed.
