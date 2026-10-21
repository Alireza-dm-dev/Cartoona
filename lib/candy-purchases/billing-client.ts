import type {
  CandyPackageSummary,
  CandyPurchasesListResponse,
  ParentAccountSummaryResponse,
  ParentCandyBillingResponse,
} from "./types"

/**
 * The billing page's browser-side reads (V0.1.46). Pure apart from `fetch`.
 *
 * The page shows three things from three Next routes, fetched in parallel:
 *   /api/candy-packages           the catalog (public, Supabase)
 *   /api/candy-purchases          purchase history (Supabase: purchases, payment attempts, coupons)
 *   /api/parent/account-summary   candy balance + welcome credits (PostgreSQL via the backend)
 *
 * The initial load and every refresh after a purchase step use the SAME
 * routes, so a displayed balance always comes from one source.
 */

export type BillingLoad =
  | { kind: "ok"; packages: CandyPackageSummary[]; billing: ParentCandyBillingResponse }
  | { kind: "session_expired" } // any 401: sign in again
  | { kind: "forbidden" } //       any 403
  | { kind: "error" } //           anything else: the retryable error card

type Fetch = typeof fetch

const NO_STORE: RequestInit = { cache: "no-store" }

function merge(summary: ParentAccountSummaryResponse, list: CandyPurchasesListResponse): ParentCandyBillingResponse {
  return {
    wallet: { balance: summary.wallet.balance },
    ...(typeof summary.welcomeImageCreditsRemaining === "number"
      ? { welcomeImageCreditsRemaining: summary.welcomeImageCreditsRemaining }
      : {}),
    purchases: list.purchases,
  }
}

function classify(responses: Response[]): BillingLoad | null {
  if (responses.some((r) => r.status === 401)) return { kind: "session_expired" }
  if (responses.some((r) => r.status === 403)) return { kind: "forbidden" }
  if (responses.some((r) => !r.ok)) return { kind: "error" }
  return null
}

/** The page's first load (and "try again"). */
export async function loadBilling(fetchImpl: Fetch = fetch): Promise<BillingLoad> {
  try {
    const [pkgResp, purchasesResp, summaryResp] = await Promise.all([
      fetchImpl("/api/candy-packages", NO_STORE),
      fetchImpl("/api/candy-purchases", NO_STORE),
      fetchImpl("/api/parent/account-summary", NO_STORE),
    ])
    const failed = classify([pkgResp, purchasesResp, summaryResp])
    if (failed) return failed
    const [pkgData, list, summary] = await Promise.all([pkgResp.json(), purchasesResp.json(), summaryResp.json()])
    return { kind: "ok", packages: pkgData.packages || [], billing: merge(summary, list) }
  } catch {
    return { kind: "error" }
  }
}

/** After a purchase step: the history and the balance again. Null keeps what is shown. */
export async function refreshBillingData(fetchImpl: Fetch = fetch): Promise<ParentCandyBillingResponse | null> {
  try {
    const [purchasesResp, summaryResp] = await Promise.all([
      fetchImpl("/api/candy-purchases", NO_STORE),
      fetchImpl("/api/parent/account-summary", NO_STORE),
    ])
    if (!purchasesResp.ok || !summaryResp.ok) return null
    return merge(await summaryResp.json(), await purchasesResp.json())
  } catch {
    return null
  }
}
