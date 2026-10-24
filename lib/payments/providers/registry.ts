import "server-only"

import { createStubAdapter, readStubConfig } from "./stub"
import type { PaymentProviderAdapter } from "./types"

/**
 * The configured payment provider (V0.1.51), read per call.
 *
 *   CARTOONA_PAYMENT_PROVIDER   "stub" (local/test only) or unset.
 *
 * Unset (the default, and production today) = no provider: starting a payment
 * answers "payment unavailable" and no purchase can become paid - exactly the
 * pre-V0.1.51 production behaviour, where only a development simulation could
 * complete a purchase. A real provider is added as another adapter here.
 */
export function configuredPaymentProvider(env: Record<string, string | undefined> = process.env): PaymentProviderAdapter | null {
  const id = env.CARTOONA_PAYMENT_PROVIDER?.trim()
  if (id === "stub") {
    const config = readStubConfig(env)
    return config ? createStubAdapter(config) : null
  }
  return null
}

/** The provider for a webhook/return path segment: only the configured one, by exact id. */
export function paymentProviderFor(pathId: string, env: Record<string, string | undefined> = process.env): PaymentProviderAdapter | null {
  const adapter = configuredPaymentProvider(env)
  return adapter && adapter.id === pathId ? adapter : null
}
