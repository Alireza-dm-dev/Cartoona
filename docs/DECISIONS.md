# Cartoona Decision Log (ADR-style)

## ADR-001: Use Next.js App Router

**Status:** Accepted

**Context:** We need a modern React framework with SSR, routing, and API support.

**Decision:** Use Next.js 16 with the App Router (file-based routing, React Server Components, layout nesting).

**Consequences:**
- Route groups for marketing, auth, dashboard, admin.
- Server components by default, client components only when needed.
- API routes in `app/api/` for server logic.

---

## ADR-002: Use Supabase

**Status:** Accepted

**Context:** We need a backend with database, auth, and file storage.

**Decision:** Use Supabase for all backend services — PostgreSQL database, authentication, and file storage.

**Consequences:**
- Three client patterns: browser (`createBrowserClient`), server (`createServerClient`), admin (`createClient` with service key).
- RLS policies on all tables.
- Service role key never exposed to client.

---

## ADR-003: Parent-First Account Model

**Status:** Accepted

**Context:** Platform must be safe for children. Children should never have independent access.

**Decision:** Only parents can create accounts. Children may have optional profiles linked to the parent account, but no authentication.

**Consequences:**
- `user.role` enum: `guest`, `parent`, `admin`, `super_admin`.
- No `child` role. No child login.
- All actions (upload, request, pay, delete) require parent auth.

---

## ADR-004: Private Media by Default

**Status:** Accepted

**Context:** Content created on Cartoona involves children and should not be public without explicit consent.

**Decision:** All uploaded and generated media is private to the parent account. No public gallery. Public sharing requires future explicit opt-in.

**Consequences:**
- Storage buckets default to private.
- Gallery pages show only the parent's own content.
- No social sharing features in MVP.

---

## ADR-005: Candy Ledger Model

**Status:** Accepted

**Context:** We need a simple, parent-friendly credit system instead of subscriptions.

**Decision:** Use a Candy credit system — parents purchase candy packs and spend candies per creation.

**Consequences:**
- One `candy_wallets` row per parent.
- Immutable `candy_transactions` ledger.
- No auto-renewal or recurring billing (reduces complexity).
- Candy costs are configurable via `config/candy-costs.ts` (later superseded by `public.creation_pricing` database table — see audit `docs/AUDIT_PRICING.md`).

---

## ADR-006: Manual/Admin Fulfillment Before Full AI Automation

**Status:** Accepted

**Context:** AI generation introduces complexity, cost, and safety risks.

**Decision:** Start with manual fulfillment — parents submit requests, admins create/download/upload content. AI integration comes after the workflow is validated.

**Consequences:**
- Admin fulfillment UI is MVP priority.
- AI provider adapters are designed later as drop-in replacements.
- Moderation workflow is built before AI generation.
- Parents experience consistent quality from day one.

---

## ADR-007: Avoid Famous Characters in MVP

**Status:** Accepted

**Context:** Licensed characters create legal risk, cost, and distraction from original content.

**Decision:** Only original Cartoona characters (Captain Candy, Princess Luma, etc.) are available. No famous/third-party characters.

**Consequences:**
- All character assets are created in-house.
- Moderation rules flag any prompt referencing famous characters.
- Future licensing is a separate business decision.

---

## ADR-009: Deferred Signup/Login for Creation Flows

**Status:** Accepted

**Context:** Traditional signup-first flows create friction. Parents exploring Cartoona may want to see what creation involves before committing to account creation. Forcing signup before exploring the creation wizard reduces conversion.

**Decision:** Use deferred signup/login — parents can explore creation flows, select options, enter request details, and review the summary before being asked to sign up or log in. Auth is requested only at the final submission step.

**Consequences:**
- Creation routes (`/create-image`, `/request-video`, `/animate-drawing`) are accessible without authentication.
- Draft state is held in-memory (browser) only — no persistence before auth + consent.
- No child media or request data is stored until parent authentication, consent, and account creation are complete.
- The `/dashboard` area remains protected for authenticated parent management.
- Signup and login routes exist but are not required to start a creation flow.
- Demo auth currently still protects `/dashboard` — deferred auth applies to creation flows only.

---

## ADR-008: Delay Public Sharing/Social Features

**Status:** Accepted

**Context:** Social features create safety, moderation, and privacy challenges.

**Decision:** No public gallery, sharing, likes, comments, or social features in MVP. All content remains private to the family.

**Consequences:**
- Simpler moderation pipeline.
- No social graph or community features.
- Future public gallery requires strict parent opt-in with granular controls.

---

## ADR-010: Server-Side PostgREST Reads Fail Fast (V0.1.36)

**Status:** Accepted

**Context:** `@supabase/postgrest-js` 2.110.2 retries every GET/HEAD/OPTIONS that throws a fetch error — including our own `FetchTimeoutError` — or answers HTTP 503/520, up to 3 more times with 1 s + 2 s + 4 s backoff. A failed read therefore cost ~7 s even when DNS failed in milliseconds, and a hanging read cost 4 × 10 s timeouts + 7 s ≈ 47 s, so `SUPABASE_REQUEST_TIMEOUT_MS` was not the upper bound it was meant to be. POST/PATCH/DELETE/RPC were never retried. The homepage also ran its three CMS reads one after another, so an unreachable backend made `/` take ~21 s.

**Decision:**
- Server, admin and middleware Supabase clients make **one network attempt per PostgREST call**. `disablePostgrestRetries()` (`lib/supabase/postgrest-retry.ts`) sets postgrest-js's documented `retry` option to `false` on the client's PostgREST instance. supabase-js does not forward that option from `createClient`, so it is set right after construction, and every `from()`, `schema()` and `rpc()` builder inherits it.
- No application-level retries. The 10 s fetch timeout is the upper bound for one call. A failed server render is retried by the user, not silently by the server.
- Write, RPC and Storage behaviour is unchanged. The library never retried them, and nothing new retries them.
- The browser client is unchanged.
- The homepage's three independent reads (`homepage_content`, `homepage_media_assets`, `homepage_hero_layout`) run concurrently. Each still degrades on its own to the committed defaults.

**Consequences:**
- A transient 503 during a PostgREST schema-cache reload is returned to the caller instead of being retried. Pages already fall back to defaults on a read error.
- `tests/unit/supabase-postgrest-retry.test.ts` drives the real supabase-js client and pins the library's default 4-attempt behaviour. A supabase-js upgrade that moves the `retry` wiring fails that test instead of quietly bringing the backoff back.

**Known open issue — Auth refresh stall (not changed here):** auth-js 2.110.2 `_refreshAccessToken` retries a failed refresh with 200 ms × 2ⁿ backoff for as long as the next attempt fits inside a 30 s window (`AUTO_REFRESH_TICK_DURATION_MS`). With an unreachable Auth backend, any request that carries an **expired** session cookie was measured waiting ~25.5–26 s, including public pages through the header account lookup. Fixing it means changing how the session refresh is bounded. That is an Auth design change with session-validity implications, so it is deferred to its own task. Session validation is not weakened.
