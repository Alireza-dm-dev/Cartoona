import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { assertSafeDatabaseTarget } from "../helpers/assert-safe-database-target";

// Load env from .env.local into process.env for guard compatibility
try {
  const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    process.env[key] = val;
  }
} catch { /* fallback */ }

const BASE = "http://localhost:3000";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://oucyhmrnzahlhqjfqcge.supabase.co";
const SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SECRET_KEY) {
  throw new Error(
    `Missing SUPABASE_SERVICE_ROLE_KEY; stateful live-price-change test requires the service role key to run safely against the database-target guard.`,
  );
}

function adminHeaders() {
  return {
    apikey: SECRET_KEY,
    Authorization: `Bearer ${SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function getDbPrice(key: string): Promise<number> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/creation_pricing?select=candy_cost&pricing_key=eq.${key}`,
    { headers: adminHeaders() },
  );
  const data = await resp.json();
  return data[0].candy_cost;
}

async function setDbPrice(key: string, cost: number): Promise<void> {
  await fetch(
    `${SUPABASE_URL}/rest/v1/creation_pricing?pricing_key=eq.${key}`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ candy_cost: cost }),
    },
  );
}

// ── Guard ─────────────────────────────────────────────────────────────
const guard = assertSafeDatabaseTarget();
if (!guard.ok) {
  throw new Error(`Guard blocked: ${guard.reason}`);
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

// ── Image price-change test ──────────────────────────────────────────────

test("database price change updates image UI without source changes", async ({ page }) => {
  test.setTimeout(60000);

  // 1. Record current price
  const originalPrice = await getDbPrice("image.default");
  console.log(`Original image.default: ${originalPrice}`);

  const tempPrice = 99;

  try {
    // 2. Change DB price
    await setDbPrice("image.default", tempPrice);

    // 3. Load creation page and verify new price
    await page.goto(`${BASE}/create-image`);
    await page.waitForLoadState("networkidle");

    // Navigate to step 3
    await page.locator('label:has(input[name="character"])').first().click();
    await page.getByRole("button", { name: "ادامه به جزئیات" }).click();
    await page.fill("#title", "Price Test");
    await page.fill("#sceneDescription", "Test scene");
    await page.fill("#style", "Test style");
    await page.getByRole("button", { name: "بررسی درخواست" }).click();
    await page.waitForTimeout(500);

    const costText = await page.locator("text=آب‌نبات").first().textContent();
    const cost = extractCost(costText);
    console.log(`Displayed cost after DB change: ${cost} (expected ${tempPrice})`);
    expect(cost).toBe(tempPrice);

    // 4. Verify image with reference file shows base + reference_file
    // Need to go back, add file, return to review
    await page.getByRole("button", { name: "ویرایش جزئیات" }).click();
    await page.locator("#referenceFile").setInputFiles({
      name: "ref.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-png"),
    });
    await page.getByRole("button", { name: "بررسی درخواست" }).click();
    await page.waitForTimeout(500);

    const refFileCost = await getDbPrice("image.reference_file");
    const expectedWithFile = tempPrice + refFileCost;

    const costWithFileText = await page.locator("text=آب‌نبات").first().textContent();
    const costWithFile = extractCost(costWithFileText);
    console.log(`Displayed cost with reference file: ${costWithFile} (expected ${expectedWithFile})`);
    expect(costWithFile).toBe(expectedWithFile);

    console.log("PASS: UI reflects database price change");
  } finally {
    // 5. Restore original
    await setDbPrice("image.default", originalPrice);
    console.log(`Restored image.default to ${originalPrice}`);
  }

  // Small delay for DB write propagation
  await new Promise(r => setTimeout(r, 500));

  // 6. Verify restored value via API
  const restoredApi = await fetch(`${BASE}/api/creation-pricing`).then(r => r.json());
  expect(restoredApi.prices["image.default"]).toBe(originalPrice);
  console.log("API confirms restored price");

  // 7. Verify UI shows restored price (cache busting via timestamp)
  await page.goto(`${BASE}/create-image?_=${Date.now()}`);
  await page.waitForLoadState("networkidle");
  await page.locator('label:has(input[name="character"])').first().click();
  await page.getByRole("button", { name: "ادامه به جزئیات" }).click();
  await page.fill("#title", "Restore Test");
  await page.fill("#sceneDescription", "Test scene");
  await page.fill("#style", "Test style");
  await page.getByRole("button", { name: "بررسی درخواست" }).click();
  await page.waitForTimeout(500);

  const restoredCostText = await page.locator("text=آب‌نبات").first().textContent();
  const restoredCost = extractCost(restoredCostText);
  console.log(`Restored displayed cost: ${restoredCost} (expected ${originalPrice})`);
  expect(restoredCost).toBe(originalPrice);
});
