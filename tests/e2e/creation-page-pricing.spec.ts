import { test, expect } from "@playwright/test";

const BASE = "http://localhost:3000";

async function getCatalog() {
  const resp = await fetch(`${BASE}/api/creation-pricing`);
  return await resp.json();
}

function extractCost(text: string | null): number | null {
  if (!text) return null;
  const persian: Record<string, string> = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };
  const digits = text.replace(/[^۰۱۲۳۴۵۶۷۸۹0-9]/g, "");
  if (!digits) return null;
  const latin = Array.from(digits).map((c) => persian[c] || c).join("");
  return parseInt(latin, 10);
}

// ── Image Flow ──────────────────────────────────────────────────────────

test.describe("Image creation flow pricing", () => {
  test("no reference file displays base cost", async ({ page }) => {
    await page.goto(`${BASE}/create-image`);
    await page.waitForLoadState("networkidle");

    await page.locator('label:has(input[name="character"])').first().click();
    await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

    await page.fill("#title", "Test Image");
    await page.fill("#sceneDescription", "Test scene");
    await page.fill("#style", "Test style");

    await page.getByRole("button", { name: "بررسی درخواست" }).click();
    await page.waitForTimeout(500);

    const catalog = await getCatalog();
    const expected = catalog.prices["image.default"];

    const costText = await page.locator("text=آب‌نبات").first().textContent();
    const cost = extractCost(costText);
    expect(cost).toBe(expected);
  });

  test("adding reference file adds surcharge", async ({ page }) => {
    await page.goto(`${BASE}/create-image`);
    await page.waitForLoadState("networkidle");

    await page.locator('label:has(input[name="character"])').first().click();
    await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

    const fileInput = page.locator("#referenceFile");
    await fileInput.setInputFiles({
      name: "ref.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-png"),
    });

    await page.fill("#title", "Test Image");
    await page.fill("#sceneDescription", "Test scene");
    await page.fill("#style", "Test style");

    await page.getByRole("button", { name: "بررسی درخواست" }).click();
    await page.waitForTimeout(500);

    const catalog = await getCatalog();
    const expected = catalog.prices["image.default"] + catalog.prices["image.reference_file"];

    const costText = await page.locator("text=آب‌نبات").first().textContent();
    const cost = extractCost(costText);
    expect(cost).toBe(expected);
  });

  test("removing file returns to base cost", async ({ page }) => {
    await page.goto(`${BASE}/create-image`);
    await page.waitForLoadState("networkidle");

    await page.locator('label:has(input[name="character"])').first().click();
    await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

    const fileInput = page.locator("#referenceFile");
    await fileInput.setInputFiles({
      name: "ref.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-png"),
    });

    // Remove file by clicking the delete button
    await page.locator('button:has-text("حذف")').click();

    await page.fill("#title", "Test Image");
    await page.fill("#sceneDescription", "Test scene");
    await page.fill("#style", "Test style");

    await page.getByRole("button", { name: "بررسی درخواست" }).click();
    await page.waitForTimeout(500);

    const catalog = await getCatalog();
    const expected = catalog.prices["image.default"];

    const costText = await page.locator("text=آب‌نبات").first().textContent();
    const cost = extractCost(costText);
    expect(cost).toBe(expected);
  });
});

// ── Video Flow ──────────────────────────────────────────────────────────

test.describe("Video creation flow pricing", () => {
  const durations = ["short", "medium", "long"] as const;
  const durLabels: Record<string, string> = { short: "کوتاه", medium: "متوسط", long: "بلند" };

  for (const dur of durations) {
    test(`${dur} without file`, async ({ page }) => {
      await page.goto(`${BASE}/request-video`);
      await page.waitForLoadState("networkidle");

      await page.locator('label:has(input[name="character"])').first().click();
      await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

      await page.fill("#title", "Test Video");
      await page.fill("#storyDescription", "Test story");
      await page.fill("#style", "Test style");
      await page.locator(`input[name="duration"][value="${durLabels[dur]}"]`).check({ force: true });

      await page.getByRole("button", { name: "بررسی درخواست" }).click();
      await page.waitForTimeout(500);

      const catalog = await getCatalog();
      const expected = catalog.prices[`video.${dur}`];

      const costText = await page.locator("text=آب‌نبات").first().textContent();
      const cost = extractCost(costText);
      expect(cost).toBe(expected);
    });

    test(`${dur} with file`, async ({ page }) => {
      await page.goto(`${BASE}/request-video`);
      await page.waitForLoadState("networkidle");

      await page.locator('label:has(input[name="character"])').first().click();
      await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

      const fileInput = page.locator("#referenceFile");
      await fileInput.setInputFiles({
        name: "ref.png",
        mimeType: "image/png",
        buffer: Buffer.from("fake-png"),
      });

      await page.fill("#title", "Test Video");
      await page.fill("#storyDescription", "Test story");
      await page.fill("#style", "Test style");
      await page.locator(`input[name="duration"][value="${durLabels[dur]}"]`).check({ force: true });

      await page.getByRole("button", { name: "بررسی درخواست" }).click();
      await page.waitForTimeout(500);

      const catalog = await getCatalog();
      const expected = catalog.prices[`video.${dur}`] + catalog.prices["video.reference_file"];

      const costText = await page.locator("text=آب‌نبات").first().textContent();
      const cost = extractCost(costText);
      expect(cost).toBe(expected);
    });
  }
});

// ── Drawing Animation Flow ─────────────────────────────────────────────

test.describe("Drawing animation flow pricing", () => {
  const durations = ["short", "medium", "long"] as const;
  const durLabels: Record<string, string> = { short: "کوتاه", medium: "متوسط", long: "بلند" };

  for (const dur of durations) {
    test(`${dur}`, async ({ page }) => {
      await page.goto(`${BASE}/animate-drawing`);
      await page.waitForLoadState("networkidle");

      // Step 1: upload drawing file
      const fileInput = page.locator("#drawingFile");
      await fileInput.setInputFiles({
        name: "drawing.png",
        mimeType: "image/png",
        buffer: Buffer.from("fake-drawing"),
      });
      await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

      // Step 2: fill details
      await page.fill("#title", "Test Drawing");
      await page.fill("#animationDescription", "Test animation");
      await page.locator('input[name="movementType"]').first().check({ force: true });
      await page.locator(`input[name="duration"][value="${durLabels[dur]}"]`).check({ force: true });

      await page.getByRole("button", { name: "بررسی درخواست" }).click();
      await page.waitForTimeout(500);

      const catalog = await getCatalog();
      const expected = catalog.prices[`drawing_animation.${dur}`];

      const costText = await page.locator("text=آب‌نبات").first().textContent();
      const cost = extractCost(costText);
      expect(cost).toBe(expected);
    });
  }

  test("selecting required drawing file does not add surcharge", async ({ page }) => {
    await page.goto(`${BASE}/animate-drawing`);
    await page.waitForLoadState("networkidle");

    // Step 1: upload drawing file
    await page.locator("#drawingFile").setInputFiles({
      name: "drawing.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-drawing"),
    });
    await page.getByRole("button", { name: "ادامه به جزئیات" }).click();

    // Step 2: fill details
    await page.fill("#title", "Test Drawing");
    await page.fill("#animationDescription", "Test animation");
      await page.locator('input[name="movementType"]').first().check({ force: true });
      await page.locator('input[name="duration"][value="متوسط"]').check({ force: true });

    await page.getByRole("button", { name: "بررسی درخواست" }).click();
    await page.waitForTimeout(500);

    const catalog = await getCatalog();
    // Drawing should NOT have a file surcharge
    const expected = catalog.prices["drawing_animation.medium"];

    const costText = await page.locator("text=آب‌نبات").first().textContent();
    const cost = extractCost(costText);
    expect(cost).toBe(expected);
  });
});
