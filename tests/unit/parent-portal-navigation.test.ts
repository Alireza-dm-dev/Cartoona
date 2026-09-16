import { describe, it, expect } from "vitest";
import {
  PARENT_NAV_ITEMS,
  PARENT_PORTAL_BRAND_HREF,
  PARENT_PORTAL_HOME,
  isParentNavItemActive,
} from "@/lib/parent/navigation/parent-nav";
import {
  CREATION_CHOICES,
  CREATION_ROUTES,
} from "@/lib/creation/creation-routes";
import { PARENT_TYPE_ROUTES } from "@/lib/parent/orders/type-mapping";
import { resolveSuccessfulLoginDestination } from "@/lib/auth/parent-destinations";

/**
 * The information architecture of the parent portal: what the navigation
 * offers, where the brand goes, and which routes the creation CTAs use.
 *
 * These are the rules that the old layout broke by hardcoding the same list
 * three times, so they are asserted against the shared config rather than
 * against any one rendering of it.
 */

describe("parent portal navigation", () => {
  it("has no dashboard entry", () => {
    expect(PARENT_NAV_ITEMS.some((i) => i.label === "داشبورد")).toBe(false);
    expect(PARENT_NAV_ITEMS.some((i) => i.href === "/dashboard")).toBe(false);
  });

  it("starts with the request list", () => {
    expect(PARENT_NAV_ITEMS[0].label).toBe("درخواست‌ها");
    expect(PARENT_NAV_ITEMS[0].href).toBe("/dashboard/orders");
    expect(PARENT_PORTAL_HOME).toBe("/dashboard/orders");
  });

  it("offers the expected destinations in order", () => {
    expect(PARENT_NAV_ITEMS.map((i) => i.label)).toEqual([
      "درخواست‌ها",
      "گالری خصوصی",
      "پروفایل",
      "آبنبات‌ها و پرداخت",
      "گرفتن تخفیف",
      "تنظیمات",
    ]);
  });

  it("labels the referral entry گرفتن تخفیف, not معرفی دوستان", () => {
    const referral = PARENT_NAV_ITEMS.find((i) => i.href === "/dashboard/referrals");
    expect(referral?.label).toBe("گرفتن تخفیف");
    expect(PARENT_NAV_ITEMS.some((i) => i.label.includes("معرفی"))).toBe(false);
  });

  it("keeps the referral route unchanged", () => {
    expect(PARENT_NAV_ITEMS.some((i) => i.href === "/dashboard/referrals")).toBe(true);
  });

  it("points the profile entry at settings rather than a second profile system", () => {
    const profile = PARENT_NAV_ITEMS.find((i) => i.label === "پروفایل");
    expect(profile?.href).toBe("/dashboard/settings#profile");
    expect(profile?.match).toBe("/dashboard/settings");
  });

  it("never offers a creation flow as a portal subsection", () => {
    for (const item of PARENT_NAV_ITEMS) {
      expect(item.href).not.toContain("create-image");
      expect(item.href).not.toContain("request-video");
      expect(item.href).not.toContain("animate-drawing");
    }
  });

  it("links the portal brand to the public homepage", () => {
    expect(PARENT_PORTAL_BRAND_HREF).toBe("/");
  });

  it("marks an item active only on whole-segment matches", () => {
    const orders = PARENT_NAV_ITEMS[0];
    expect(isParentNavItemActive(orders, "/dashboard/orders")).toBe(true);
    expect(isParentNavItemActive(orders, "/dashboard/orders/abc")).toBe(true);
    expect(isParentNavItemActive(orders, "/dashboard/orders-archive")).toBe(false);
    expect(isParentNavItemActive(orders, "/dashboard/gallery")).toBe(false);
  });
});

describe("creation CTA routing", () => {
  it("maps each creation choice to its public website route", () => {
    expect(CREATION_ROUTES).toEqual({
      image: "/create-image",
      video: "/request-video",
      drawing_animation: "/animate-drawing",
    });
  });

  it("never routes creation through /dashboard", () => {
    for (const choice of CREATION_CHOICES) {
      expect(choice.href.startsWith("/dashboard")).toBe(false);
    }
    for (const route of Object.values(PARENT_TYPE_ROUTES)) {
      expect(route.startsWith("/dashboard")).toBe(false);
    }
  });

  it("offers all three creation choices", () => {
    expect(CREATION_CHOICES.map((c) => c.type)).toEqual([
      "image",
      "video",
      "drawing_animation",
    ]);
    expect(CREATION_CHOICES.map((c) => c.label)).toEqual([
      "تصویر کارتونی",
      "ویدیوی کارتونی",
      "جان‌بخشی به نقاشی",
    ]);
  });

  it("keeps the order list and the creation pages on one set of routes", () => {
    expect(PARENT_TYPE_ROUTES).toEqual(CREATION_ROUTES);
  });
});

describe("portal entry", () => {
  it("sends a consented parent to the request list, not a dashboard", () => {
    expect(resolveSuccessfulLoginDestination(null, true)).toBe(PARENT_PORTAL_HOME);
    expect(resolveSuccessfulLoginDestination("/dashboard", true)).toBe(PARENT_PORTAL_HOME);
  });
});
