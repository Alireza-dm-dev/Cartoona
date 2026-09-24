/**
 * The admin panel's navigation.
 *
 * Declared here rather than inline in the layout for the same reason
 * `lib/parent/navigation/parent-nav.ts` exists: the desktop nav, the mobile
 * nav and the unit tests must read one list. Before this, the admin layout
 * repeated the entries twice, which is precisely how a nav entry outlives the
 * page it points at.
 *
 * Deliberately absent (V0.1.21): `/admin/users`, `/admin/candy-ledger`,
 * `/admin/media` and `/admin/moderation`. Those four pages rendered
 * hard-coded Persian sample rows — invented parents, invented candy
 * transactions, an invented safety queue — with every action disabled, and
 * nothing behind them. An operator could not tell them apart from the real
 * screens, so the routes were deleted rather than hidden. Anything that
 * replaces them must read the database before it is listed here again.
 *
 * `/admin/settings` and `/admin/characters` stay: both state on screen that
 * they are نمایشی (demonstrative) and disable their controls, and characters
 * additionally lists the real `config/characters.ts` entries, so neither can
 * be mistaken for live operational data.
 */
export interface AdminNavItem {
  /** Persian label shown to the admin. */
  label: string;
  href: string;
}

export const ADMIN_BRAND_LABEL = "پنل مدیریت کارتونا";

export const ADMIN_BRAND_HREF = "/admin";

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { label: "داشبورد", href: "/admin" },
  { label: "درخواست‌ها", href: "/admin/requests" },
  { label: "نمونه‌ها", href: "/admin/examples" },
  { label: "صفحه اصلی", href: "/admin/homepage" },
  { label: "شخصیت‌ها", href: "/admin/characters" },
  { label: "مدیریت معرفی", href: "/admin/referrals" },
  { label: "کدهای تخفیف", href: "/admin/coupons" },
  { label: "تنظیمات", href: "/admin/settings" },
];
