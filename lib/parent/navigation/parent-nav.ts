/**
 * The parent portal's navigation.
 *
 * Declared here rather than inline in the layout so the desktop nav, the
 * mobile nav and the unit tests all read the same list — the three could
 * otherwise drift, which is how the old "داشبورد" entry outlived the page it
 * pointed at.
 *
 * Deliberately absent: a dashboard entry. `/dashboard` is a redirect to
 * `/dashboard/orders`, not a destination, and creation is not a portal
 * subsection — those CTAs link to the public routes in
 * `lib/creation/creation-routes.ts`.
 */
export interface ParentNavItem {
  /** Persian label shown to the parent. */
  label: string;
  href: string;
  /**
   * Route prefix that marks this item active. Kept separate from `href` so an
   * item pointing at an anchor or a shared page can still highlight correctly.
   */
  match: string;
}

/** Where the parent portal brand links. Back to the public site, not /dashboard. */
export const PARENT_PORTAL_BRAND_HREF = "/";

export const PARENT_PORTAL_BRAND_LABEL = "پنل والدین کارتونا";

/** The parent's first destination after entering the portal. */
export const PARENT_PORTAL_HOME = "/dashboard/orders";

export const PARENT_NAV_ITEMS: readonly ParentNavItem[] = [
  { label: "درخواست‌ها", href: "/dashboard/orders", match: "/dashboard/orders" },
  { label: "گالری خصوصی", href: "/dashboard/gallery", match: "/dashboard/gallery" },
  // Profile and settings are one page. The profile entry deep-links to the
  // account section of it rather than introducing a second profile system.
  { label: "پروفایل", href: "/dashboard/settings#profile", match: "/dashboard/settings" },
  { label: "آبنبات‌ها و پرداخت", href: "/dashboard/billing", match: "/dashboard/billing" },
  { label: "گرفتن تخفیف", href: "/dashboard/referrals", match: "/dashboard/referrals" },
  { label: "تنظیمات", href: "/dashboard/settings", match: "/dashboard/settings" },
];

/**
 * True when `pathname` sits under the given nav item.
 *
 * Compares whole segments so `/dashboard/orders-archive` never lights up the
 * `/dashboard/orders` entry.
 */
export function isParentNavItemActive(item: ParentNavItem, pathname: string): boolean {
  if (pathname === item.match) return true;
  return pathname.startsWith(item.match + "/");
}
