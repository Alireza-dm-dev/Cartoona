import { describe, test, expect } from "vitest";
import { calculateCreationCost } from "@/lib/pricing/calculate-creation-cost";
import type { CreationPricingCatalog } from "@/lib/pricing/calculate-creation-cost";
import { CREATION_PRICING_KEYS } from "@/lib/pricing/pricing-keys";

function fullCatalog(): CreationPricingCatalog {
  return {
    [CREATION_PRICING_KEYS.imageDefault]: 12,
    [CREATION_PRICING_KEYS.imageReferenceFile]: 3,
    [CREATION_PRICING_KEYS.videoShort]: 40,
    [CREATION_PRICING_KEYS.videoMedium]: 60,
    [CREATION_PRICING_KEYS.videoLong]: 90,
    [CREATION_PRICING_KEYS.videoReferenceFile]: 5,
    [CREATION_PRICING_KEYS.drawingAnimationShort]: 35,
    [CREATION_PRICING_KEYS.drawingAnimationMedium]: 50,
    [CREATION_PRICING_KEYS.drawingAnimationLong]: 75,
  };
}

function assertAvailable(
  result: ReturnType<typeof calculateCreationCost>,
): asserts result is { available: true; candyCost: number; pricingKeys: string[] } {
  expect(result.available).toBe(true);
}

describe("calculateCreationCost", () => {
  test("valid catalog with all nine keys", () => {
    const catalog = fullCatalog();
    expect(Object.keys(catalog)).toHaveLength(9);
    for (const [, cost] of Object.entries(catalog)) {
      expect(typeof cost).toBe("number");
      expect(cost).toBeGreaterThan(0);
    }
  });

  test("image without reference costs 12", () => {
    const result = calculateCreationCost(fullCatalog(), "image", null, false);
    assertAvailable(result);
    expect(result.candyCost).toBe(12);
    expect(result.pricingKeys).toEqual(["image.default"]);
  });

  test("image with reference costs 15", () => {
    const result = calculateCreationCost(fullCatalog(), "image", null, true);
    assertAvailable(result);
    expect(result.candyCost).toBe(15);
    expect(result.pricingKeys).toEqual(["image.default", "image.reference_file"]);
  });

  test("video short without reference costs 40", () => {
    const result = calculateCreationCost(fullCatalog(), "video", "short", false);
    assertAvailable(result);
    expect(result.candyCost).toBe(40);
  });

  test("video short with reference costs 45", () => {
    const result = calculateCreationCost(fullCatalog(), "video", "short", true);
    assertAvailable(result);
    expect(result.candyCost).toBe(45);
  });

  test("video medium without reference costs 60", () => {
    const result = calculateCreationCost(fullCatalog(), "video", "medium", false);
    assertAvailable(result);
    expect(result.candyCost).toBe(60);
  });

  test("video medium with reference costs 65", () => {
    const result = calculateCreationCost(fullCatalog(), "video", "medium", true);
    assertAvailable(result);
    expect(result.candyCost).toBe(65);
  });

  test("video long without reference costs 90", () => {
    const result = calculateCreationCost(fullCatalog(), "video", "long", false);
    assertAvailable(result);
    expect(result.candyCost).toBe(90);
  });

  test("video long with reference costs 95", () => {
    const result = calculateCreationCost(fullCatalog(), "video", "long", true);
    assertAvailable(result);
    expect(result.candyCost).toBe(95);
  });

  test("drawing short costs 35", () => {
    const result = calculateCreationCost(fullCatalog(), "drawing_animation", "short", false);
    assertAvailable(result);
    expect(result.candyCost).toBe(35);
  });

  test("drawing medium costs 50", () => {
    const result = calculateCreationCost(fullCatalog(), "drawing_animation", "medium", false);
    assertAvailable(result);
    expect(result.candyCost).toBe(50);
  });

  test("drawing long costs 75", () => {
    const result = calculateCreationCost(fullCatalog(), "drawing_animation", "long", false);
    assertAvailable(result);
    expect(result.candyCost).toBe(75);
  });

  test("drawing with file does not add surcharge", () => {
    const noFile = calculateCreationCost(fullCatalog(), "drawing_animation", "medium", false);
    const withFile = calculateCreationCost(fullCatalog(), "drawing_animation", "medium", true);
    assertAvailable(noFile);
    assertAvailable(withFile);
    expect(noFile.candyCost).toBe(withFile.candyCost);
    expect(withFile.pricingKeys).toHaveLength(1);
  });

  test("missing base price fails", () => {
    const catalog: CreationPricingCatalog = {};
    const result = calculateCreationCost(catalog, "image", null, false);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("missing_price");
  });

  test("missing surcharge fails when file required", () => {
    const catalog: CreationPricingCatalog = { "image.default": 12 };
    const result = calculateCreationCost(catalog, "image", null, true);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("missing_price");
  });

  test("non-positive cost fails", () => {
    const catalog: CreationPricingCatalog = { "image.default": 0 };
    const result = calculateCreationCost(catalog, "image", null, false);
    expect(result.available).toBe(false);
  });

  test("negative cost fails", () => {
    const catalog: CreationPricingCatalog = { "image.default": -5 };
    const result = calculateCreationCost(catalog, "image", null, false);
    expect(result.available).toBe(false);
  });

  test("unknown duration fails", () => {
    const result = calculateCreationCost(fullCatalog(), "video", null as unknown as "short", false);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("unsupported_options");
  });

  test("unsupported type fails", () => {
    const result = calculateCreationCost(fullCatalog(), "unknown" as "image", null, false);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("unsupported_options");
  });

  test("function does not accept draft estimate", () => {
    const draftEstimate = 999;
    const result = calculateCreationCost(fullCatalog(), "image", null, false);
    assertAvailable(result);
    expect(result.candyCost).not.toBe(draftEstimate);
    expect(result.candyCost).toBe(12);
  });
});
