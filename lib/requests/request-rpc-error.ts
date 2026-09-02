export interface RequestRpcError {
  status: number
  code: string
  error: string
  headers?: Record<string, string>
}

export function mapRequestRpcError(message: unknown, hint: unknown): RequestRpcError {
  const code = typeof message === "string" ? message : "unknown_error"
  const error = typeof hint === "string" ? hint : "ثبت درخواست با خطا مواجه شد"

  let status = 422
  if (code === "request_unauthenticated") status = 401
  else if (
    code === "request_parent_required" ||
    code === "request_consent_required" ||
    code === "request_parent_profile_missing"
  ) status = 403
  else if (code === "INSUFFICIENT_CANDIES") status = 402
  else if (code === "CANDY_WALLET_NOT_FOUND") status = 409

  if (code === "CREATION_PRICING_UNAVAILABLE") {
    return {
      status: 503,
      code,
      error: "قیمت این درخواست در حال حاضر در دسترس نیست.",
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }
  }

  return { status, code, error }
}
