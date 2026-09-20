import { test, expect, type Page } from "@playwright/test"

/**
 * Preset chips on the public creation forms.
 *
 * Read-only: these are the anonymous creation routes, so nothing here
 * authenticates, writes to storage or touches the database. That is why this
 * spec needs no disposable-target guard, unlike the stateful parent specs.
 *
 * The draft is kept in sessionStorage until the parent signs in, so "the
 * review step receives the final value" is asserted on step 3 of the form
 * rather than after submission.
 */

const BASE = process.env.CARTOONA_TEST_BASE_URL || "http://localhost:3000"

const chip = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true })

/**
 * Step 1 asks for a character; every preset field lives on step 2.
 *
 * The character radios are visually hidden inside their labels, hence `force`.
 */
async function gotoStepTwo(page: Page, route: string): Promise<void> {
  await page.goto(`${BASE}${route}`)
  await page.getByRole("radio").first().check({ force: true })
  await page.getByRole("button", { name: "ادامه به جزئیات" }).click()
  await expect(page.getByRole("button", { name: "بررسی درخواست" })).toBeVisible()
}

/** Step 2 -> step 3. */
async function gotoReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "بررسی درخواست" }).click()
}

test.describe("/request-video presets", () => {
  test("a story preset fills the textarea with a starter sentence", async ({ page }) => {
    await gotoStepTwo(page, "/request-video")

    const story = page.locator("#storyDescription")
    await expect(story).toHaveValue("")

    await chip(page, "سفر به فضا").click()
    await expect(story).toHaveValue(
      "کودک همراه شخصیت انتخاب‌شده در یک سفینه فضایی رنگارنگ بین سیاره‌ها ماجراجویی کند.",
    )
    // The chip reads as selected, and only that one.
    await expect(chip(page, "سفر به فضا")).toHaveAttribute("aria-pressed", "true")
    await expect(chip(page, "جشن تولد کودک")).toHaveAttribute("aria-pressed", "false")
  })

  test("choosing a different preset replaces the previous generated value", async ({ page }) => {
    await gotoStepTwo(page, "/request-video")
    const story = page.locator("#storyDescription")

    await chip(page, "سفر به فضا").click()
    const first = await story.inputValue()
    await chip(page, "ماجراجویی در جنگل").click()
    const second = await story.inputValue()

    expect(second).not.toBe(first)
    expect(second).toContain("جنگل")
    await expect(chip(page, "سفر به فضا")).toHaveAttribute("aria-pressed", "false")
    await expect(chip(page, "ماجراجویی در جنگل")).toHaveAttribute("aria-pressed", "true")
  })

  test("the textarea stays editable and manual text is never erased", async ({ page }) => {
    await gotoStepTwo(page, "/request-video")
    const story = page.locator("#storyDescription")

    await chip(page, "جشن تولد کودک").click()
    await story.click()
    await story.press("End")
    await story.pressSequentially(" و کیک شکلاتی داشته باشد.")

    const edited = await story.inputValue()
    expect(edited).toContain("و کیک شکلاتی داشته باشد.")
    // No chip claims the edited text.
    await expect(chip(page, "جشن تولد کودک")).toHaveAttribute("aria-pressed", "false")

    // Typing from scratch works too.
    await story.fill("یک داستان کاملاً دلخواه")
    await expect(story).toHaveValue("یک داستان کاملاً دلخواه")
  })

  test("an occasion preset fills the field and it stays editable", async ({ page }) => {
    await gotoStepTwo(page, "/request-video")
    const occasion = page.locator("#occasion")

    await chip(page, "شب یلدا").click()
    await expect(occasion).toHaveValue("شب یلدا")

    await occasion.fill("سالگرد خانوادگی")
    await expect(occasion).toHaveValue("سالگرد خانوادگی")
    await expect(chip(page, "شب یلدا")).toHaveAttribute("aria-pressed", "false")
  })

  test("required validation still applies when no preset is used", async ({ page }) => {
    await gotoStepTwo(page, "/request-video")
    await gotoReview(page)
    await expect(page.getByText("لطفاً توضیح داستان یا صحنه را وارد کنید.")).toBeVisible()
  })

  test("the review step shows the final value, preset or typed", async ({ page }) => {
    await gotoStepTwo(page, "/request-video")

    await chip(page, "نجات یک حیوان").click()
    const generated = await page.locator("#storyDescription").inputValue()
    await chip(page, "تبریک موفقیت").click()

    await page.locator("#storyDescription").click()
    await page.locator("#storyDescription").press("End")
    await page.locator("#storyDescription").pressSequentially(" پایان خوش.")
    const finalStory = await page.locator("#storyDescription").inputValue()
    expect(finalStory).not.toBe(generated)

    await page.getByRole("radio", { name: "۵ تا ۱۰ ثانیه" }).check({ force: true })
    await page.getByRole("radio", { name: "بله، کاراکترها صحبت کنند" }).check({ force: true })
    await gotoReview(page)

    await expect(page.getByText(finalStory, { exact: false })).toBeVisible()
    await expect(page.getByText("تبریک موفقیت", { exact: false }).first()).toBeVisible()
  })
})

test.describe("/create-image presets", () => {
  test("a scene preset fills the textarea with a starter sentence", async ({ page }) => {
    await gotoStepTwo(page, "/create-image")
    const scene = page.locator("#sceneDescription")

    await chip(page, "دنیای جادویی").click()
    await expect(scene).toHaveValue(
      "کودک در یک دنیای جادویی و رنگارنگ با نورهای درخشان و فضای فانتزی قرار داشته باشد.",
    )
    await expect(chip(page, "دنیای جادویی")).toHaveAttribute("aria-pressed", "true")
  })

  test("a style preset fills the field and a custom style is still accepted", async ({ page }) => {
    await gotoStepTwo(page, "/create-image")
    const style = page.locator("#style")

    await chip(page, "آبرنگی").click()
    await expect(style).toHaveValue("آبرنگی")

    await chip(page, "کمیک").click()
    await expect(style).toHaveValue("کمیک")
    await expect(chip(page, "آبرنگی")).toHaveAttribute("aria-pressed", "false")

    await style.fill("سبک دلخواه من")
    await expect(style).toHaveValue("سبک دلخواه من")
    await expect(chip(page, "کمیک")).toHaveAttribute("aria-pressed", "false")
  })

  test("an occasion preset fills the field and the field stays optional", async ({ page }) => {
    await gotoStepTwo(page, "/create-image")
    const occasion = page.locator("#occasion")

    await chip(page, "نوروز").click()
    await expect(occasion).toHaveValue("نوروز")

    // Cleared again, step 2 still advances — occasion is not required.
    await occasion.fill("")
    await page.locator("#sceneDescription").fill("یک صحنه دلخواه")
    await page.locator("#style").fill("کارتونی")
    await gotoReview(page)
    await expect(page.getByText("یک صحنه دلخواه", { exact: false })).toBeVisible()
  })

  test("required validation still applies when no preset is used", async ({ page }) => {
    await gotoStepTwo(page, "/create-image")
    await gotoReview(page)
    await expect(page.getByText("لطفاً توضیح صحنه را وارد کنید.")).toBeVisible()
    await expect(page.getByText("لطفاً سبک تصویر را وارد کنید.")).toBeVisible()
  })

  test("the review step shows the final values", async ({ page }) => {
    await gotoStepTwo(page, "/create-image")

    await chip(page, "بازی در پارک").click()
    await chip(page, "نقاشی دستی").click()
    await chip(page, "دوستی").click()
    const scene = await page.locator("#sceneDescription").inputValue()

    await gotoReview(page)

    await expect(page.getByText(scene, { exact: false })).toBeVisible()
    await expect(page.getByText("نقاشی دستی", { exact: false }).first()).toBeVisible()
    await expect(page.getByText("دوستی", { exact: false }).first()).toBeVisible()
  })

  test("chips are keyboard reachable and operable", async ({ page }) => {
    await gotoStepTwo(page, "/create-image")
    const target = chip(page, "جشن تولد")
    await target.focus()
    await expect(target).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator("#sceneDescription")).not.toHaveValue("")
    await expect(target).toHaveAttribute("aria-pressed", "true")
  })
})
