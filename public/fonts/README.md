# Cartoona Production Font Assets

## Digi Madasi Bold

| Field | Value |
|---|---|
| File | `digi-madasi-bold.ttf` |
| Weight | 700 (Bold) |
| Format | TrueType (`.ttf`) |
| Usage | Hero headlines, display titles, `.font-brand` class |
| Source | External designer (source unknown) |
| License | **⚠️ Verify before production use.** Currently used for foundation/interim design only. See `docs/DESIGN_SYSTEM.md:92`. |
| Note | Replace with a properly licensed alternative if rights cannot be confirmed. |

## Vazir

| Field | Value |
|---|---|
| Files | `Vazir.woff2` (400), `Vazir-Medium.woff2` (500), `Vazir-Bold.woff2` (700) |
| Format | WOFF2 (`.woff2`) |
| Usage | Default body text, UI labels, forms, descriptions, cards, navigation |
| Source | [rastikerdar/vazir-font](https://github.com/rastikerdar/vazir-font) v16.1.0 |
| License | SIL Open Font License 1.1 |
| Note | Vazir is the predecessor to Vazirmatn. Both are under SIL OFL. See `docs/DESIGN_SYSTEM.md:77`. |

## Typography Rules

- **Display/brand text** → Digi Madasi (via `.font-brand`)
- **Body / UI text** → Vazir (default via `--font-sans`)
- Do not use Digi Madasi for body text, forms, or long paragraphs.
- Do not use Vazir for hero/display headings (low visual impact).

## Adding a New Font Weight

1. Place the font file in this directory.
2. Add `@font-face` block in `app/globals.css`.
3. Document the addition here.
