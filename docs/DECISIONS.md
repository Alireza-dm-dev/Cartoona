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
- Candy costs are configurable via `config/candy-costs.ts`.

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

## ADR-008: Delay Public Sharing/Social Features

**Status:** Accepted

**Context:** Social features create safety, moderation, and privacy challenges.

**Decision:** No public gallery, sharing, likes, comments, or social features in MVP. All content remains private to the family.

**Consequences:**
- Simpler moderation pipeline.
- No social graph or community features.
- Future public gallery requires strict parent opt-in with granular controls.
