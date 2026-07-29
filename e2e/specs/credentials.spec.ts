import { test, expect, type Page } from "@playwright/test";
import { hasFormula } from "@app/shared";
import { AppClient, SEED_EMAIL, SEED_PASSWORD } from "../helpers/app-client";

/**
 * The values a workflow types. A variable is ordinary data and can be read and
 * corrected; a secret is write-only — the server never sends it back, so the
 * page cannot offer to edit it, only to replace it.
 */

async function loginThroughUi(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(SEED_EMAIL);
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

test.describe("variables and secrets", () => {
  let client: AppClient;
  let suffix: string;

  test.beforeEach(async ({ page }) => {
    client = new AppClient();
    await client.login();
    suffix = String(Date.now());
    await loginThroughUi(page);
    await page.goto("/credentials");
  });

  test("corrects a variable in place", async ({ page }) => {
    const name = `citta${suffix}`;
    await client.saveCredential(name, "Verona", "variable");
    await page.reload();

    await expect(page.getByTestId(`credential-value-${name}`)).toHaveText("Verona");
    await page.getByTestId(`credential-edit-${name}`).click();

    const field = page.getByTestId(`credential-input-${name}`);
    await expect(field, "a variable is editable, so it starts from what it holds").toHaveValue(
      "Verona"
    );
    await field.fill("Vicenza");
    await page.getByTestId(`credential-save-${name}`).click();

    await expect(page.getByTestId(`credential-value-${name}`)).toHaveText("Vicenza");
    const stored = (await client.listCredentials()).find((c) => c.name === name);
    expect(stored).toMatchObject({ value: "Vicenza", hasValue: true });
  });

  test("replaces a secret without ever showing it", async ({ page }) => {
    const name = `token${suffix}`;
    await client.saveCredential(name, "il-vecchio-segreto", "secret");
    await page.reload();

    const row = page.getByTestId(`credential-row-${name}`);
    await expect(row).not.toContainText("il-vecchio-segreto");

    await page.getByTestId(`credential-edit-${name}`).click();
    const field = page.getByTestId(`credential-input-${name}`);
    // Never prefilled: the server does not send a secret back, and a field that
    // looked prefilled would be a lie about what saving is going to store.
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("type", "password");

    await field.fill("il-nuovo-segreto");
    await page.getByTestId(`credential-save-${name}`).click();

    await expect(row).toContainText("nascosto");
    await expect(row).not.toContainText("il-nuovo-segreto");
    const stored = (await client.listCredentials()).find((c) => c.name === name);
    expect(stored).toMatchObject({ value: null, hasValue: true });
  });

  test("never advertises a formula the engine does not know", async ({ page }) => {
    // The page lists the tokens without importing the engine — the browser
    // bundle deliberately holds no workspace package. So the list is checked
    // against the engine here instead of being trusted.
    const tokens = await page
      .locator("[data-token]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-token") ?? ""));
    expect(tokens.length, "the help must list something").toBeGreaterThan(0);
    for (const token of tokens) {
      expect(hasFormula(token), `${token} is offered but not recognised`).toBe(true);
    }
  });

  test("marks a variable that changes at every run", async ({ page }) => {
    const name = `unico${suffix}`;
    await client.saveCredential(name, "repo-{{timestamp}}", "variable");
    await page.reload();

    const row = page.getByTestId(`credential-row-${name}`);
    await expect(row).toContainText("formula");
    // What is stored is the formula, not one of its answers.
    await expect(page.getByTestId(`credential-value-${name}`)).toHaveText("repo-{{timestamp}}");
  });

  test("puts a formula in the value, without anyone typing braces", async ({ page }) => {
    // The tokens were listed under the whole form, so it was not clear which
    // field they belonged to — the first thing tried was typing one into the
    // name, which the API refuses and the preview rendered as nonsense.
    await page.getByTestId("credential-name").fill(`ordine${suffix}`);
    await page.getByTestId("formula-token-random").click();
    await page.getByTestId("formula-token-date").click();

    await expect(page.getByTestId("credential-value")).toHaveValue("{{random}}{{date}}");
    await expect(page.getByTestId("credential-name"), "the name is left alone").toHaveValue(
      `ordine${suffix}`
    );

    await page.getByTestId("credential-submit").click();
    await expect(page.getByTestId(`credential-row-ordine${suffix}`)).toContainText("formula");
  });

  test("says when a value holds nothing", async ({ page }) => {
    // Saving a workflow creates every reference it makes, empty. Those entries
    // are exactly the ones waiting to be filled in here.
    const name = `daRiempire${suffix}`;
    await client.saveCredential(name, "", "variable");
    await page.reload();

    await expect(page.getByTestId(`credential-value-${name}`)).toHaveText("(vuota)");
  });

  test("gives up an edit without changing anything", async ({ page }) => {
    const name = `annulla${suffix}`;
    await client.saveCredential(name, "originale", "variable");
    await page.reload();

    await page.getByTestId(`credential-edit-${name}`).click();
    await page.getByTestId(`credential-input-${name}`).fill("scartato");
    await page.getByTestId(`credential-cancel-${name}`).click();

    await expect(page.getByTestId(`credential-value-${name}`)).toHaveText("originale");
    expect((await client.listCredentials()).find((c) => c.name === name)?.value).toBe("originale");
  });
});
