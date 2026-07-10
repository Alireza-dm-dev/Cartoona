# Cartoona Features

## MVP Features (Foundation + Manual Request Platform)

### Foundation (Current)
- [x] Marketing homepage with product explanation and CTA
- [x] Character showcase page (original characters only)
- [x] Examples page (safe fictional examples)
- [x] Pricing page (candy system explanation)
- [x] Safety and privacy page
- [x] FAQ page
- [x] Login page placeholder
- [x] Signup page placeholder
- [x] Parent consent page placeholder
- [x] Parent dashboard with candy balance, requests overview, quick actions
- [x] Admin dashboard with stats overview
- [x] Admin request queue page
- [x] Admin media review page
- [x] Admin user management page
- [x] Admin character management page
- [x] Admin candy ledger page
- [x] Admin moderation queue page
- [x] Admin settings page
- [x] Design system with Cartoona color palette
- [x] Minimal reusable UI components
- [x] Database schema draft
- [x] Supabase client stubs
- [x] Project documentation

### MVP 1 — Manual Request Platform
- [ ] Supabase Auth (parent signup/login/logout)
- [ ] Email/password authentication
- [ ] Parent account creation with consent
- [ ] Create order (image/video/drawing_animation)
- [ ] Upload drawing for animation requests
- [ ] Admin order queue with status updates
- [ ] Admin fulfillment — upload generated content
- [ ] Parent order tracking with status
- [ ] Private gallery — view completed orders
- [ ] Download delivered content
- [ ] Basic moderation — approve/flag/block
- [ ] Audit logging
- [ ] Account settings (profile, privacy)
- [ ] Account deletion

### MVP 2 — Controlled Image Generation
- [ ] AI image generation provider integration
- [ ] Controlled wizard UI — character + theme + prompt
- [ ] Admin review of generated images before delivery
- [ ] Automated prompt safety checks
- [ ] Media asset library (admin)

### MVP 3 — Payments
- [ ] Stripe integration
- [ ] Candy pack purchases
- [ ] Auto-deduct candies on order submission
- [ ] Transaction history in dashboard
- [ ] Refund processing

### MVP 4 — Launch Polish
- [ ] RLS policies on all tables
- [ ] Storage bucket setup
- [ ] Email notifications
- [ ] Data export
- [ ] Performance optimization
- [ ] Security audit
- [ ] Beta program

## Future Features (Post-MVP)

- Video generation from text/script
- Drawing animation (upload child drawing → animate)
- Multiple character scenes
- Voice narration
- Enhanced prompt builder with presets
- Parent opt-in public gallery
- Mobile app (React Native or PWA)
- Email/SMS notifications
- Referral program

## Explicitly Out-of-Scope Features (Will Not Build)

- **Full AI generation** in foundation phase — manual fulfillment first.
- **Full Stripe payment flow** in foundation — candy costs are placeholders.
- **Public gallery** — all content is private by default.
- **Famous/licensed character system** — original characters only.
- **Social features** — no likes, comments, shares, following.
- **Child-owned accounts** — children never have independent access.
- **WhatsApp/Telegram automation** — no chat integrations.
- **Complex analytics** — basic stats only.
- **Marketplace** — no buying/selling of creations between users.
- **Voice cloning** — out of scope.
- **Print-on-demand** — digital delivery only.
- **Advanced prompt engineering panel** — simple predefined options only.

## Feature Priority Order

1. Foundation (current) — project setup, design system, routes, docs
2. MVP 1 — manual request platform with auth
3. MVP 2 — controlled image generation
4. MVP 3 — payments (Stripe)
5. MVP 4 — launch readiness (RLS, storage, security)
6. Post-MVP — video, animation, mobile
