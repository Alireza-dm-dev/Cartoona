import { test, expect, type Page } from "@playwright/test"

/**
 * The optional child name on the public creation forms.
 *
 * Read-only: these are the anonymous creation routes, so nothing here
 * authenticates, writes to storage or touches the database. That is why this
 * spec needs no disposable-target guard, unlike the stateful parent specs.
 *
 * The draft lives in sessionStorage until the parent signs in, so "the value
 * survives the interruption" is asserted against that storage rather than
 * against a submitted request.
 */

const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"
const DRAFT_KEY = "cartoona_creation_draft_v1"

const routes = [
  { path: "/create-image", continueLabel: "ادامه و ساخت تصویر" },
  { path: "/request-video", continueLabel: "ادامه و ساخت ویدیو" },
] as const

/** Step 1 asks for a character; the child-name field lives on step 2. */
async function gotoStepTwo(page: Page, route: string): Promise<void> {
  await page.goto(`${BASE}${route}`)
  await page.getByRole("radio").first().check({ force: true })
  await page.getByRole("button", { name: "ادامه به جزئیات" }).click()
  await expect(page.getByRole("button", { name: "بررسی درخواست" })).toBeVisible()
}

/** Fill whatever step 2 requires, so the review step can be reached. */
async function fillRequiredDetails(page: Page, route: string): Promise<void> {
  if (route === "/create-image") {
    await page.locator("#sceneDescription").fill("یک صحنه شاد در جنگل")
    await page.locator("#style").fill("کارتونی نرم")
    return
  }
  await page.locator("#storyDescription").fill("یک ماجرای کوتاه و شاد")
  // Duration and speech are explicit radio choices on the video form.
  await page.getByRole("radio", { name: /۵|5/ }).first().check({ force: true })
  await page.getByRole("radio", { name: "بله، کاراکترها صحبت کنند" }).check({ force: true })
}

for (const { path, continueLabel } of routes) {
  test.describe(`child name on ${path}`, () => {
    test("sits with the reference upload and reaches the review step", async ({ page }) => {
      await gotoStepTwo(page, path)

      const field = page.locator("#childName")
      await expect(field).toBeVisible()
      await expect(page.locator('label[for="childName"]')).toHaveText("نام کودک")
      await expect(field).toHaveAttribute("placeholder", "مثلاً: آریا")

      // It belongs to the reference-image group: the upload control follows it.
      await expect(page.locator('label[for="referenceFile"]')).toBeVisible()

      await field.fill("آریا")
      await fillRequiredDetails(page, path)
      await page.getByRole("button", { name: "بررسی درخواست" }).click()

      await expect(page.getByText("نام کودک", { exact: true })).toBeVisible()
      await expect(page.getByText("آریا", { exact: true })).toBeVisible()
    })

    test("is optional and produces no review row when left blank", async ({ page }) => {
      await gotoStepTwo(page, path)
      await fillRequiredDetails(page, path)
      await page.getByRole("button", { name: "بررسی درخواست" }).click()

      // Reaching review at all proves it did not block the step.
      await expect(page.getByRole("button", { name: continueLabel })).toBeVisible()
      await expect(page.getByText("نام کودک", { exact: true })).toHaveCount(0)
    })

    test("rejects a value with no letters in it", async ({ page }) => {
      await gotoStepTwo(page, path)
      await fillRequiredDetails(page, path)
      await page.locator("#childName").fill("12345")
      await page.getByRole("button", { name: "بررسی درخواست" }).click()

      await expect(page.getByRole("alert").filter({ hasText: "نام کودک" })).toBeVisible()
      // Still on step 2: the review step was not reached.
      await expect(page.getByRole("button", { name: "بررسی درخواست" })).toBeVisible()
    })

    test("is trimmed and stored in the draft that survives the signup hand-off", async ({ page }) => {
      await gotoStepTwo(page, path)
      await fillRequiredDetails(page, path)
      await page.locator("#childName").fill("  آریا  ")
      await page.getByRole("button", { name: "بررسی درخواست" }).click()
      await page.getByRole("button", { name: continueLabel }).click()

      // The draft is written just before the parent is sent to signup.
      await page.waitForURL(/\/signup/)

      const draft = await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) || "null"),
        DRAFT_KEY,
      )
      expect(draft).not.toBeNull()
      expect(draft.version).toBe(1)
      expect(draft.childName).toBe("آریا")

      // And the signup page echoes it back in the pending-draft summary, which
      // is what tells the parent their work was not lost.
      await expect(page.getByText("نام کودک", { exact: true })).toBeVisible()
      await expect(page.getByText("آریا", { exact: true })).toBeVisible()
    })

    test("writes no childName into the draft when left blank", async ({ page }) => {
      await gotoStepTwo(page, path)
      await fillRequiredDetails(page, path)
      await page.getByRole("button", { name: "بررسی درخواست" }).click()
      await page.getByRole("button", { name: continueLabel }).click()
      await page.waitForURL(/\/signup/)

      const draft = await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) || "null"),
        DRAFT_KEY,
      )
      // Null, never "": the column rejects a blank string.
      expect(draft.childName).toBeNull()
      await expect(page.getByText("نام کودک", { exact: true })).toHaveCount(0)
    })
  })
}
