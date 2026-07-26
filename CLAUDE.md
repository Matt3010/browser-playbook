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
