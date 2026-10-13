# Rate limiting

Provider-neutral foundation (V0.1.32). Routes depend only on `lib/rate-limit`
(`enforceRateLimit`, `RATE_LIMIT_POLICIES`); the counter storage is a
`RateLimitStore` that can be swapped via `setRateLimitStore()`.

## Current vs production

| | Store | Suitable for |
|---|---|---|
| **Now** | `InMemoryRateLimitStore` | local dev and a **single** long-lived instance |
| **Required for multi-instance / serverless production** | a `DistributedRateLimitStore` adapter (Redis/Upstash, a platform limiter, a DB table, ...) | horizontally scaled deployments |

The in-memory store keeps counters in process memory. With N instances the
effective limit is roughly `limit x N`, and counters reset on every cold start.
It is a safety net, **not** a complete defence, until a shared adapter exists.
An adapter only has to implement `consume(key, policy)` atomically (e.g.
`INCR` + `PEXPIRE`) and must not count denied attempts. No route or policy
changes are needed. Set `RATE_LIMIT_HASH_SECRET` (same value on every instance)
if IP keys are used with a shared store.

## Keys
- Authenticated actions: the verified **user id**. Never IP, token or cookie.
- Unauthenticated endpoints (none use it yet): `clientIpRateLimitKey()` — an
  HMAC digest of the normalized IP; the raw IP is never stored or logged.
  **No forwarding header is trusted by default.** Set
  `RATE_LIMIT_TRUSTED_IP_HEADER` (e.g. `x-forwarded-for`, `x-real-ip`) only when
  your proxy overwrites it; the rightmost `X-Forwarded-For` entry is used. Until
  then all such callers share one fallback bucket (strict, deterministic).

## Policies (per parent)
| Policy | Limit | Routes |
|---|---|---|
| request_submit_burst / hourly | 5 / min, 30 / h | POST /api/requests |
| final_media_sign | 30 / min | POST /api/parent/orders/[orderId]/final-media |
| coupon_validate | 20 / min | POST /api/coupons/validate |
| coupon_apply | 10 / min | POST /api/candy-purchases/[id]/coupon |
| candy_purchase_mutation | 10 / min | POST /api/candy-purchases, /[id]/complete |
| password_change | 5 / min | POST /api/parent/password |

Reads (`/api/parent/gallery`, `/api/parent/orders`) are intentionally unlimited.

## Behaviour
- 429 `{ "error": "rate_limited" }` with `Retry-After`, `X-RateLimit-*`, `Cache-Control: no-store`.
- One `RATE_LIMITED` log event per rejection (policy, retryAfterSeconds, requestId, route — no keys).
- **Fail-open**: if the limiter throws, the request proceeds and `RATE_LIMITER_FAILED` is logged.
- `RATE_LIMIT_DISABLED=1` bypasses limiting (use for e2e suites that hammer endpoints; never in production).
- Fixed window: a client can burst up to 2x the limit across a window boundary.
