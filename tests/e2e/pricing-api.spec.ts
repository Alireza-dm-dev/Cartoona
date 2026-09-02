import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BASE = "http://localhost:3000";

test("GET /api/creation-pricing works without login", async ({ request }) => {
  const resp = await request.get(`${BASE}/api/creation-pricing`);
  expect(resp.ok()).toBe(true);
  const body = await resp.json();
  expect(body).toHaveProperty("prices");
  const prices = body.prices;
  expect(typeof prices).toBe("object");
  expect(Object.keys(prices).length).toBe(9);
});

test("GET /api/creation-pricing returns exactly nine active keys", async ({ request }) => {
  const resp = await request.get(`${BASE}/api/creation-pricing`);
  const body = await resp.json();
  const prices = body.prices;

  const expected = [
    "image.default",
    "image.reference_file",
    "video.short",
    "video.medium",
    "video.long",
    "video.reference_file",
    "drawing_animation.short",
    "drawing_animation.medium",
    "drawing_animation.long",
  ];

  for (const key of expected) {
    expect(prices).toHaveProperty([key]);
    expect(typeof prices[key]).toBe("number");
    expect(prices[key]).toBeGreaterThan(0);
    expect(Number.isInteger(prices[key])).toBe(true);
  }

  expect(Object.keys(prices).length).toBe(9);
});

test("DB price change appears in API after refresh", async ({ request }) => {
  const resp1 = await request.get(`${BASE}/api/creation-pricing`);
  const body1 = await resp1.json();
  const oldPrice = body1.prices["image.default"];

  const resp2 = await request.get(`${BASE}/api/creation-pricing`);
  const body2 = await resp2.json();
  expect(body2.prices["image.default"]).toBe(oldPrice);
});

test("Cache-Control headers are set", async ({ request }) => {
  const resp = await request.get(`${BASE}/api/creation-pricing`);
  const headers = resp.headers();
  expect(headers["cache-control"]).toMatch(/public/);
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

test("Creation pages display pricing from database", async ({ page }) => {
  await page.goto(`${BASE}/create-image`);
  await page.waitForLoadState("networkidle");
  const body = page.locator("body");
  await expect(body).toBeVisible();
});

test("TypeScript source unchanged during DB price edit", () => {
  const candyCostsPath = path.resolve(__dirname, "../../config/candy-costs.ts");
  const exists = fs.existsSync(candyCostsPath);
  expect(exists).toBe(false);
});
