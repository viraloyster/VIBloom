import { expect, test, type Page } from "@playwright/test";

// Everything here runs with no AI connected: the app must work by hand.

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test("a BZ recipe runs its experiments with predictions made by hand", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Start from a BZ recipe" }).click();

  // The engine asks for a prediction before each experiment, one at a time.
  const ask = page.getByRole("dialog", { name: "Your prediction" });
  await expect(ask).toContainText("The full model oscillates");
  await ask.getByRole("button", { name: "It will hold" }).click();
  await expect(ask).toContainText("The two-variable model keeps the period");
  await ask.getByRole("button", { name: "It will hold" }).click();
  await expect(ask).toBeHidden();

  // 0.2 M malonic acid gives about 67 s, where the reduction is far off.
  await expect(page.locator(".root")).toHaveCount(3);
  await expect(page.getByText("Surprise: you expected holds, the run fails.")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText("The two-variable model keeps the period").first().click();
  await expect(page.getByText(/predicted holds \(70%\).*wrong/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("a root written with the form is computed by the engine", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.getByLabel("What do you want to build?").fill("A cardboard bridge for one person");
  await page.getByRole("button", { name: "Start by hand" }).click();
  await page.getByRole("button", { name: "Add a root by hand" }).click();

  const form = page.getByRole("dialog", { name: "A new root" });
  await form.getByRole("button", { name: "Add the root" }).click();
  await expect(form).toContainText("Give the root a title.");

  await form.getByPlaceholder("A few words").fill("The deck carries the load");
  await form.getByRole("button", { name: "Add a number" }).click();
  await form.getByRole("button", { name: "Add a number" }).click();
  const rows = form.locator(".param-row");
  await rows.nth(0).getByPlaceholder("name").fill("person_kg");
  await rows.nth(0).getByPlaceholder("value").fill("90");
  await rows.nth(0).getByPlaceholder("unit").fill("kg");
  await rows.nth(1).getByPlaceholder("name").fill("capacity_kg");
  await rows.nth(1).getByPlaceholder("value").fill("60");
  await rows.nth(1).getByPlaceholder("unit").fill("kg");
  await form.getByLabel("How it is tested").selectOption("arithmetic");
  // A safety factor of 1.5 on the person's weight, against what the deck holds.
  await form.getByPlaceholder("load * span / 4").fill("person_kg * 1.5");
  await form.getByPlaceholder("strength").fill("capacity_kg");
  await form.getByRole("button", { name: "Add the root" }).click();
  await expect(form).toBeHidden();

  // 135 kg against 60 kg: the engine says it fails.
  await expect(page.locator(".root")).toHaveCount(1);
  await expect(page.getByText("Your formula, evaluated by VIBloom")).toBeVisible();
  await expect(page.getByText(/fails with these values/i).first()).toBeVisible();
  // No AI: nothing offers one.
  await expect(page.getByRole("button", { name: "Visualize with the AI" })).toHaveCount(0);
  await expect(page.getByLabel("Chat", { exact: true })).toBeHidden();
  expect(errors).toEqual([]);
});
