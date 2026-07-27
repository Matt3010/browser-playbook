import { test, expect, type Page } from "@playwright/test";
import { AppClient, SEED_EMAIL, SEED_PASSWORD } from "../helpers/app-client";

/**
 * The shell every page sits in. The navigation used to be a row across the top,
 * which is fine until the window is not wide: a sidebar can be folded away when
 * the content needs the width — the remote browser stream always does — and the
 * choice has to survive, because nobody wants to fold it again on every page.
 */

async function loginThroughUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(SEED_EMAIL);
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

test.describe("the application shell", () => {
  test.beforeEach(async ({ page }) => {
    const client = new AppClient();
    await client.login();
    await loginThroughUi(page);
  });

  test("navigates from the sidebar", async ({ page }) => {
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.getByTestId("nav-workflows").click();
    await expect(page).toHaveURL(/\/workflows$/);
    await page.getByTestId("nav-credentials").click();
    await expect(page).toHaveURL(/\/credentials$/);
  });

  test("folds away and stays folded", async ({ page }) => {
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");

    await page.getByTestId("sidebar-toggle").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    // Folded, it gives the width back to what the page is for. The fold is
    // animated, so the width is waited for rather than read on the spot.
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBeLessThan(96);

    // The choice belongs to the person, not to the page they made it on.
    await page.reload();
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");

    await page.getByTestId("nav-executions").click();
    await expect(page).toHaveURL(/\/executions$/);
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  });

  test("every section is still reachable while folded", async ({ page }) => {
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");

    for (const id of [
      "nav-dashboard",
      "nav-workflows",
      "nav-credentials",
      "nav-executions",
      "nav-notifications"
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId("logout")).toBeVisible();
  });

  test("nothing reflows while it folds and unfolds", async ({ page }) => {
    // The labels are wider than the folded column. Left to wrap, they turn one
    // line into two halfway through the animation: the rows grow, the whole
    // sidebar shuffles, and the page next to it moves with it.
    const rowHeight = async () =>
      (await page.getByTestId("nav-credentials").boundingBox())!.height;

    const unfolded = await rowHeight();
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    await expect.poll(rowHeight).toBe(unfolded);

    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
    await expect.poll(rowHeight).toBe(unfolded);

    // Nothing in it may wrap: not the labels, not the title, not the button.
    const wrapping = await page
      .getByTestId("sidebar")
      .evaluate((aside) =>
        [...aside.querySelectorAll("*")]
          .filter((el) => getComputedStyle(el).whiteSpace === "normal" && el.children.length === 0)
          .map((el) => el.textContent?.trim())
          .filter((text): text is string => !!text && text.length > 0)
      );
    expect(wrapping, "everything with text in the sidebar must be kept on one line").toEqual([]);
  });

  test("folds itself when the window gets narrow, and comes back when it does not", async ({
    page
  }) => {
    // A sidebar is a quarter of a narrow window, taken from the page that needs
    // it most. It should not have to be folded by hand every time the window is
    // resized — or the browser opened next to something else.
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");

    await page.setViewportSize({ width: 1400, height: 800 });
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");

    // Still openable by hand while narrow: folding is the default, not a rule.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
  });

  test("still says who is logged in", async ({ page }) => {
    await expect(page.getByTestId("current-user")).toContainText(SEED_EMAIL);
  });
});
