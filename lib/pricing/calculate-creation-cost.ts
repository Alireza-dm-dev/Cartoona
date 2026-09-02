import type { CreationPricingKey, InternalDuration } from "./pricing-keys"
import { CREATION_PRICING_KEYS } from "./pricing-keys"

export type CreationPricingCatalog = Record<CreationPricingKey, number>

export type CreationCostResult =
  | { available: true; candyCost: number; pricingKeys: CreationPricingKey[] }
  | { available: false; reason: "missing_price" | "inactive_price" | "unsupported_options" }

function readCost(catalog: CreationPricingCatalog, key: CreationPricingKey): number | null {
  const cost = catalog[key]
  if (typeof cost !== "number") return null
  if (cost <= 0) return null
  if (!Number.isInteger(cost)) return null
  return cost
}

export function calculateCreationCost(
  catalog: CreationPricingCatalog,
  type: "image" | "video" | "drawing_animation",
  durationKey: InternalDuration | null,
  hasFile: boolean,
): CreationCostResult {
  if (type === "image") {
    const keys: CreationPricingKey[] = [CREATION_PRICING_KEYS.imageDefault]
    if (hasFile) {
      keys.push(CREATION_PRICING_KEYS.imageReferenceFile)
    }
    return sumCosts(catalog, keys)
  }

  if (type === "video") {
    let baseKey: CreationPricingKey
    if (durationKey === "short") baseKey = CREATION_PRICING_KEYS.videoShort
    else if (durationKey === "medium") baseKey = CREATION_PRICING_KEYS.videoMedium
    else if (durationKey === "long") baseKey = CREATION_PRICING_KEYS.videoLong
    else return { available: false, reason: "unsupported_options" }

    const keys: CreationPricingKey[] = [baseKey]
    if (hasFile) {
      keys.push(CREATION_PRICING_KEYS.videoReferenceFile)
    }
    return sumCosts(catalog, keys)
  }

  if (type === "drawing_animation") {
    let baseKey: CreationPricingKey
    if (durationKey === "short") baseKey = CREATION_PRICING_KEYS.drawingAnimationShort
    else if (durationKey === "medium") baseKey = CREATION_PRICING_KEYS.drawingAnimationMedium
    else if (durationKey === "long") baseKey = CREATION_PRICING_KEYS.drawingAnimationLong
    else return { available: false, reason: "unsupported_options" }

    return sumCosts(catalog, [baseKey])
  }

  return { available: false, reason: "unsupported_options" }
}

function sumCosts(catalog: CreationPricingCatalog, keys: CreationPricingKey[]): CreationCostResult {
  let total = 0
  for (const key of keys) {
    const cost = readCost(catalog, key)
    if (cost === null) {
      return { available: false, reason: "missing_price" }
    }
    total += cost
  }
  if (total <= 0) {
    return { available: false, reason: "inactive_price" }
  }
  return { available: true, candyCost: total, pricingKeys: [...keys] }
}
