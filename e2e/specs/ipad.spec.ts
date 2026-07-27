import { test, expect, type Page } from "@playwright/test";
import {
  AppClient,
  TEST_WEB_INTERNAL_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
  resetTestWeb,
  step
} from "../helpers/app-client";

/**
 * The application on an iPad: a touch screen about half as wide as a desktop
 * window, in a browser that reacts badly to a page that does not say how wide it
 * wants to be — Safari lays such a page out at 980 px and shrinks it, so every
 * control ends up too small to hit accurately.
 *
 * Portrait is the harder case and the one people hold a tablet in, so it is what
 * this measures. Phones are deliberately out of scope.
 */
const IPAD_PORTRAIT = { width: 834, height: 1112 };

test.use({ viewport: IPAD_PORTRAIT, hasTouch: true });

/** How much of the page cannot be reached without scrolling sideways. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

async function loginThroughUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(SEED_EMAIL);
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

test.describe("usable on an iPad", () => {
  let client: AppClient;
  let workflowId: string;

  test.beforeEach(async ({ page }) => {
    await resetTestWeb();
    client = new AppClient();
    await client.login();
    // A name as long as the ones people actually use: the header holds it next
    // to the rename, the status and the two run buttons.
    const workflow = await client.createWorkflow(
      `Crea la scheda cliente sul gestionale e invia la conferma ${Date.now()}`,
      `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
    );
    workflowId = workflow.id;
    await client.putSteps(workflowId, [
      step({
        type: "goto",
        name: "Vai al wizard",
        value: `${TEST_WEB_INTERNAL_URL}/wizard/step-1`
      }),
      step({
        type: "fill",
        name: "Inserisci un nome molto lungo per vedere se la riga sfonda il bordo",
        value: "Mario",
        selector: {
          strategy: "label",
          value: "Nome",
          fallback: "#fullname",
          pageId: "main",
          frame: null
        }
      })
    ]);
    await loginThroughUi(page);
  });

  test("declares its width, so Safari does not lay it out for a desktop", async ({ page }) => {
    // Without this the whole page is rendered at 980 px and scaled down: nothing
    // is broken, everything is just too small to use.
    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute("content", { timeout: 10_000 });
    expect(viewport ?? "").toContain("width=device-width");
  });

  test("no page asks to be scrolled sideways", async ({ page }) => {
    const pages = [
      "/dashboard",
      "/workflows",
      `/workflows/${workflowId}`,
      "/executions",
      "/credentials",
      "/notifications"
    ];
    for (const path of pages) {
      await page.goto(path);
      await expect(page.getByTestId("current-user")).toBeVisible();
      expect(await horizontalOverflow(page), `${path} overflows sideways`).toBeLessThanOrEqual(1);
    }
  });

  test("every section stays reachable from the header", async ({ page }) => {
    await page.goto("/dashboard");
    for (const id of [
      "nav-dashboard",
      "nav-workflows",
      "nav-credentials",
      "nav-executions",
      "nav-notifications"
    ]) {
      await expect(page.getByTestId(id)).toBeInViewport();
    }
    await expect(page.getByTestId("logout")).toBeInViewport();
  });

  test("typing in a field does not zoom the page in", async ({ page }) => {
    // Safari zooms towards any input whose text is smaller than 16 px, and never
    // zooms back out: one tap on a field and the rest of the page is off-screen.
    await page.goto(`/workflows/${workflowId}`);
    const size = await page
      .getByTestId("start-url")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  });

  test("a drag on the stream reaches the remote browser, not the page", async ({ page }) => {
    // noVNC does not set `touch-action` itself, so without this a drag on the
    // canvas scrolls and zooms the page around it and the remote browser never
    // sees the gesture.
    await page.goto(`/workflows/${workflowId}`);
    await page.getByTestId("start-browser").click();
    await expect(page.getByTestId("session-state")).toContainText("ready", { timeout: 90_000 });

    const viewer = page.getByTestId("vnc-viewer");
    await expect(viewer).toBeVisible();
    expect(await viewer.evaluate((el) => getComputedStyle(el).touchAction)).toBe("none");

    // And the stream fits the screen it is streamed to.
    const box = await viewer.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(IPAD_PORTRAIT.height);

    await page.getByTestId("close-session").click();
  });

  test("offers a way to write into the remote browser", async ({ page }) => {
    // The stream is a canvas: tapping a field inside it raises no keyboard,
    // because there is nothing on this side to focus. The field that does raise
    // one is here, and the text is typed remotely by the server.
    await page.goto(`/workflows/${workflowId}`);
    await page.getByTestId("start-browser").click();
    await expect(page.getByTestId("session-state")).toContainText("ready", { timeout: 90_000 });

    const field = page.getByTestId("type-text");
    await expect(field).toBeVisible();
    expect(
      await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      "a smaller field would make Safari zoom in on every tap"
    ).toBeGreaterThanOrEqual(16);
    for (const id of ["type-send", "type-enter", "type-tab"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height, `${id} is too short to tap`).toBeGreaterThanOrEqual(32);
    }

    await page.getByTestId("close-session").click();
  });

  test("the controls are big enough to hit with a finger", async ({ page }) => {
    await page.goto(`/workflows/${workflowId}`);
    for (const id of ["step-up-1", "step-down-1", "save-steps", "start-browser"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} is not on the page`).toBeTruthy();
      expect(box!.height, `${id} is too short to tap`).toBeGreaterThanOrEqual(32);
    }
  });
});
