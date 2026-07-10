# Cartoona Design System

## Product Design Principles

1. **Parent-first** — Every visual decision prioritizes clarity, trust, and calm confidence.
2. **Child-delightful** — Colors and shapes feel playful but never childish or exclusionary to adults.
3. **Safe and warm** — Rounded shapes, soft colors, approachable typography.
4. **Clear over clever** — UI communicates clearly before it impresses.
5. **Private by default** — Visual design reinforces that this is a private, safe space.

## Brand Personality

- Warm, friendly, approachable
- Not cartoonish — it's a tool for parents, not a game for kids
- Playful but professional
- Trustworthy and transparent
- Colorful but not chaotic

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

- **Primary font:** Geist (already configured via next/font)
- **Fallback:** system-ui, sans-serif
- **Headings:** Bold, rounded feel (Geist has a friendly character)
- **Body:** Regular weight, readable size (16px base)
- **TODO:** Evaluate importing a more rounded font (e.g., Fredoka, Nunito) for headings post-MVP.

### Font Sizes

| Element | Size | Weight |
|---|---|---|
| H1 | 2.5–3rem | 700 |
| H2 | 1.75–2rem | 700 |
| H3 | 1.25–1.5rem | 600 |
| Body | 0.875–1rem | 400 |
| Small | 0.75–0.8125rem | 400 |
| Badge | 0.75rem | 500 |

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

| Status | Visual |
|---|---|
| Draft | Default badge (gray) |
| Pending Payment | Warning badge (yellow) |
| Pending Review | Info badge (blue) |
| In Progress | Info badge (blue) |
| Ready | Success badge (green) |
| Delivered | Success badge (green) |
| Rejected | Danger badge (coral) |
| Cancelled | Danger badge (coral) |

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
