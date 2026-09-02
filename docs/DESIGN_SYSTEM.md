# Cartoona Design System

## Product Design Principles

1. **Persian-first** — The default UI language is Persian/Farsi. English is treated as future localization, not the base design.
2. **RTL-first** — All layout, navigation, and reading flow default to right-to-left direction.
3. **Parent-first** — Every visual decision prioritizes clarity, trust, and calm confidence for the parent user.
4. **Child-delightful** — Colors and shapes feel playful but never childish or exclusionary to adults.
5. **Safe and warm** — Rounded shapes, soft colors, approachable typography.
6. **Clear over clever** — UI communicates clearly before it impresses.
7. **Private by default** — Visual design reinforces that this is a private, safe space.

## Brand Personality

- Warm, friendly, approachable
- Not cartoonish — it's a tool for parents, not a game for kids
- Playful but professional
- Trustworthy and transparent
- Colorful but not chaotic

## Product Language

- **Default UI language is Persian/Farsi.** All user-facing labels, buttons, empty states, validation messages, and status labels must be designed in Persian first.
- English is not the default MVP interface language. Future English support should be implemented as a localization layer, not the base design.
- Do not mix English labels into Persian UI unless the term is a technical/admin-only concept with no clear Persian equivalent (e.g., API, UUID).
- Brand logo text: «کارتونا».

## Visual Modes

- **Light mode only** for MVP. Dark mode is future.
- High contrast for readability.
- Accessible color combinations.

## Color Tokens

### Primary Palette

| Token | Hex | Usage |
|---|---|---|
| `background` | `#FFF7E8` | Page backgrounds |
| `cream` | `#FFF7E8` | Page backgrounds, card backgrounds |
| `candy-pink` | `#FF6FB1` | Primary actions, CTAs, brand accent |
| `sky-blue` | `#5BC7F7` | Info, secondary accent, links |
| `sunshine-yellow` | `#FFD84D` | Warnings, candy balance, highlights |
| `mint-green` | `#7EE6B8` | Success states, positive indicators |
| `soft-purple` | `#A78BFA` | Character categories, creative accent |
| `coral` | `#FF8A65` | Danger, deletion, destructive actions |
| `parent-navy` | `#26324A` | Headings, primary text on light |
| `text-dark` | `#2B2B35` | Body text |
| `soft-border` | `#F0DCC7` | Borders, dividers, subtle separators |
| `card` | `#FFFFFF` | Card backgrounds |
| `card-foreground` | `#2B2B35` | Card text |

### Semantic Token Mapping

| Usage | Token |
|---|---|
| Primary button | `candy-pink` |
| Danger button | `coral` |
| Success badge | `mint-green` |
| Warning badge | `sunshine-yellow` |
| Info badge | `sky-blue` |
| Default badge | `soft-border` |
| Link text | `sky-blue` |
| Error text | `coral` |

## Typography Direction

### Current (Temporary)

- **Primary font:** Geist (already configured via next/font)
- **Fallback:** system-ui, sans-serif
- **Status:** Geist is acceptable only as a temporary technical placeholder for the foundation phase. It does not support Persian text well and must be replaced before MVP launch.

### Persian Typography (Target)

- **Body font:** Vazirmatn (free, open-source, SIL Open Font License) for body text, forms, dashboard, and admin. Use the variable-weight version for flexibility.
- **Heading font:** Vazirmatn (bold/extra-bold weights) or Estedad for headings and display text. Both are free and open-source.
- **Do not ship paid fonts** (Dana, IRANSans) into the repository unless licensing is handled outside the repo.
- **Persian numerals** should be used in parent-facing UI (prices, dates, quantities). Admin/internal technical areas may optionally use Latin digits for IDs and system values.
- **TODO:** Import Vazirmatn via next/font when transitioning from Geist. See `https://github.com/rastikerdar/vazirmatn`.

### Brand/Display Persian Font (Digi Madasi Bold)

- **Font name:** Digi Madasi Bold
- **File:** `public/fonts/digi-madasi-bold.ttf`
- **Loaded via:** `@font-face` in `app/globals.css`
- **CSS utility class:** `.font-brand` — applies `"DigiMadasi"` with Geist and system-ui as fallbacks
- **Usage:** logo-style text, hero heading, selected marketing accents only
- **Not for:** body text, forms, admin tables, long paragraphs, or any high-readability-content
- **Body font remains Geist** temporarily until a readable Persian body font such as Vazirmatn is added later
- **TODO:** confirm font licensing before production use — Digi Madasi Bold is currently used for foundation/interim design only
- **Font weight available:** 700 (Bold only)

### Font Sizes (unchanged by language direction)

| Element | Size | Weight |
|---|---|---|
| H1 | 2.5–3rem | 700 |
| H2 | 1.75–2rem | 700 |
| H3 | 1.25–1.5rem | 600 |
| Body | 0.875–1rem | 400 |
| Small | 0.75–0.8125rem | 400 |
| Badge | 0.75rem | 500 |

## RTL Layout Principles

- **Default direction is `rtl`.** Page flow, navigation, breadcrumbs, wizards, tables, and forms should follow right-to-left direction.
- Primary actions appear on the left side in Persian RTL forms (matching the prototype), while the reading flow remains right-to-left.
- Back/continue controls: «بازگشت» (back) and «ادامه» (continue), positioned per the prototype.
- Step indicators in the creation wizard should read right-to-left (step 1 on the right).
- Parent-facing mobile flow is strictly RTL-first.
- Admin area may use a fixed sidebar with RTL content; sidebar position (right or left) should be documented once decided. For now, parent-facing content is RTL; admin can follow the same direction for consistency.
- Icons with directional meaning (arrows, chevrons, back, forward, share) must be mirrored in RTL mode unless they represent a non-directional concept.
- Avoid LTR-only layouts. Do not hard-code `left`/`right` in styles without an RTL-aware utility.

## RTL-aware Component Checklist (future)

The following component behaviors require RTL attention:
- Chevrons in accordions, breadcrumbs, and back buttons
- Pagination direction
- Form field label alignment
- Card grids (order within rows)
- Sidebar position
- Input group addons (prefix/suffix)
- Table column alignment for numeric vs. text columns

## Persian Microcopy Rules

All user-facing strings must be in Persian. Examples:

| Context | Persian |
|---|---|
| Primary CTA | «ساخت کارتون جدید» |
| Secondary CTA | «مشاهده نمونه‌ها» |
| Continue | «ادامه» |
| Back | «بازگشت» |
| Login | «ورود» |
| Signup | «ثبت‌نام» |
| Safety note | «محتوای کودک فقط برای والدین قابل مشاهده است.» |
| Upload helper | «فایل JPG یا PNG را بارگذاری کنید.» |
| Empty gallery | «گالری خصوصی شما هنوز خالی است.» |
| Success message | «درخواست شما با موفقیت ثبت شد.» |
| Error message | «لطفاً فایل معتبر بارگذاری کنید.» |
| Save | «ذخیره» |
| Cancel | «لغو» |
| Delete | «حذف» |
| Edit | «ویرایش» |
| View all | «مشاهده همه» |
| Start now | «شروع کنید» |
| Learn more | «بیشتر بدانید» |
| Loading | «در حال بارگذاری» |
| No results | «نتیجه‌ای یافت نشد» |

## Prototype-based Screen Direction

The following screen templates should be designed in Persian in future UI work. These are design guidance, not implementation requirements.

- **Mobile welcome screen:** Persian headline, Persian CTA, RTL layout, narrow card-like frame with soft shadow.
- **Parent dashboard:** Compact cards for candy balance, active orders, privacy reminders, recent creations. All labels in Persian.
- **Creation type selection:** Step-based flow with numbered indicators. Visual option cards in Persian. Sticky cost/CTA area at bottom.
- **Character selection:** RTL-scrolling horizontal list or grid. Persian labels for category and character name.
- **Upload/consent step:** Upload dropzone with Persian helper text. Consent checkbox with Persian privacy notice. Sticky continue button.
- **Review and success screen:** Order summary in Persian. Success banner with Persian confirmation text.
- **Order detail page:** Persian status labels, Persian timeline, RTL detail layout.
- **Admin request detail:** Navy sidebar/header, compact tables, clear production statuses in Persian, less playful decoration.

## Component Updates for Persian/RTL

The following components must support RTL layout and Persian labels. Implementation is future work:

- **Button** — text in Persian, icon mirroring for directional icons
- **Card** — RTL text alignment, Persian content
- **Badge** — Persian status labels, RTL-aware positioning
- **EmptyState** — Persian title, description, action label
- **PageHeader** — RTL alignment, Persian title/description
- **SectionShell** — RTL spacing
- **SafetyNotice** — Persian text, RTL layout
- **CandyBalanceBadge** — Persian numeral formatting
- **OrderStatusBadge** — Persian status labels
- **StepWizard** — RTL step order (right to left), Persian labels
- **UploadDropzone** — Persian helper text, RTL layout
- **ConsentCheckbox** — Persian label, RTL-aligned
- **CandyCostPreview** — Persian numerals, RTL alignment
- **AdminRequestTable** — RTL table, Persian headers
- **OrderTimeline** — RTL timeline direction
- **StatusTimeline** — RTL timeline, Persian labels

## Status Labels in Persian

| Status | English | Persian |
|---|---|---|
| draft | Draft | «پیش‌نویس» |
| pending_payment | Pending Payment | «در انتظار پرداخت» |
| pending_review | Pending Review | «در حال بررسی» |
| in_progress | In Progress | «در حال انجام» |
| ready | Ready | «آماده تحویل» |
| delivered | Delivered | «تحویل داده شده» |
| rejected | Rejected | «رد شده» |
| cancelled | Cancelled | «لغو شده» |

## Persian Accessibility Rules

- Persian labels must be clear and readable at intended font sizes.
- Font size must not be too small for Persian text (baseline 16px body, minimum 14px for supporting text).
- Avoid low-contrast pastel text — Persian script requires sufficient stroke contrast.
- Inputs must have visible Persian labels (placeholder-only labels are not acceptable).
- Error messages must be in Persian and associated with the relevant input.
- `dir="rtl"` must not break keyboard navigation or screen-reader announcements.
- Icons cannot replace Persian text for critical actions (e.g., a trash icon must be accompanied by the Persian word «حذف»).
- Focus indicators must be visible in RTL layout.

## Spacing / Radius / Shadow Rules

### Spacing (8px grid)

- `p-1` = 8px, `p-2` = 16px, `p-3` = 24px, `p-4` = 32px, `p-6` = 48px, `p-8` = 64px
- Gap between cards: 16–24px (`gap-4` to `gap-6`)
- Section padding: 64–96px (`py-16` to `py-24`)

### Max-Width by Context

| Context | Max Width |
|---|---|
| Marketing | 1120–1200px |
| Dashboard | 1180–1280px |
| Admin | 1280–1440px |
| Wizard | 720–880px |

### Border Radius

| Element | Radius |
|---|---|
| Playful cards | 20–28px (`rounded-[24px]`) |
| Admin/data cards | 12–16px (`rounded-xl`) |
| Buttons sm | 8px (`rounded-lg`) |
| Buttons md/lg | 12–16px (`rounded-xl`) |
| Badges | Full (`rounded-full`) |
| Inputs | 8–12px |

### Shadows

- Cards: `shadow-sm` (subtle elevation)
- Hover: `shadow-md`
- Modals: `shadow-lg`
- Avoid heavy shadows — keep it flat and friendly.

## Component Guidelines

### Card
- Playful variant: 24px radius, white background, soft border.
- Admin variant: 12px radius, white background, soft border.
- No shadow by default (use `variant` for context).

### Button
- Primary: candy-pink background, white text, rounded-xl.
- Secondary: white background, soft border, text-dark text.
- Ghost: transparent, text-dark, hover has background.
- Danger: coral background, white text.
- Disabled: reduced opacity.

### Badge
- Small, rounded-full, colored by semantic variant.
- Use for status indicators, labels, and tags.

### EmptyState
- Dashed border container with icon, title, description, and optional action.
- Used for empty lists, no-data states.

### PageHeader
- Title + optional description + optional action (right-aligned on desktop).

### SectionShell
- Standard section wrapper with vertical padding.

### SafetyNotice
- Blue-tinted card with shield icon. Used for safety/privacy messaging.

## Page Templates

Each page template includes:
- `PageHeader` with title + description.
- Content area with appropriate max-width.
- TODO comments for missing features.

## Form Rules

- Labels above inputs.
- Clear validation messages.
- Single column on mobile, multi-column on desktop for grouped fields.
- Disabled submit until valid.

## Status System

| Status | Persian Label | Visual |
|---|---|---|
| draft | «پیش‌نویس» | Default badge (gray) |
| pending_payment | «در انتظار پرداخت» | Warning badge (yellow) |
| pending_review | «در حال بررسی» | Info badge (blue) |
| in_progress | «در حال انجام» | Info badge (blue) |
| ready | «آماده تحویل» | Success badge (green) |
| delivered | «تحویل داده شده» | Success badge (green) |
| rejected | «رد شده» | Danger badge (coral) |
| cancelled | «لغو شده» | Danger badge (coral) |

## Empty / Loading / Success / Error States

- **Empty:** `EmptyState` component with title, description, optional action.
- **Loading:** Skeleton placeholders (future).
- **Success:** Toast notification or inline success banner (future).
- **Error:** Coral-tinted error card or inline message (future).

## Responsive Rules

- Marketing: single column mobile, multi-column ≥768px.
- Dashboard: sidebar navigation hidden on mobile, hamburger menu (future).
- Admin: fixed sidebar ≥1024px, collapsed on mobile.
- Breakpoints: sm (640), md (768), lg (1024), xl (1280).

## Accessibility Checklist

- [ ] All interactive elements keyboard-accessible.
- [ ] Color contrast meets WCAG AA (4.5:1 for text).
- [ ] Form inputs have associated labels.
- [ ] Images have alt text.
- [ ] Roles and ARIA attributes for complex widgets.
- [ ] Focus indicators visible.
- [ ] Error messages associated with inputs.
- [ ] Not reliant on color alone for conveying status.

## Do-Not-Design List

- No dark mode (future).
- No child-themed UI (no toys, no childish fonts).
- No social sharing buttons.
- No public gallery components.
- No famous character brands/logos.
- No gamification elements for children.
- No child dashboard or child account UI.
- No English-first UI — do not build screens in English as the default.
- No mixed English/Persian labels — do not mix random English terms into Persian UI.
- No LTR-only components — do not create layouts that break under `dir="rtl"`.
- No decorative Persian fonts for forms or admin — use readable body fonts (Vazirmatn).
- No child-facing game UI — Cartoona is a parent tool, not a children's game.
- No famous-character names even in Persian — only original Cartoona characters.
