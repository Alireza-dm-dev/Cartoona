import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ADMIN_NAV_ITEMS, ADMIN_BRAND_HREF } from "@/lib/admin/navigation/admin-nav";
import { PARENT_NAV_ITEMS } from "@/lib/parent/navigation/parent-nav";

/**
 * Guards V0.1.21 — the four fabricated admin pages and the fabricated parent
 * children page were deleted, not merely unlinked.
 *
 * These are regression guards rather than behaviour tests: the failure they
 * exist to catch is someone re-adding a nav entry for a page that does not
 * exist, or restoring a mock page and wiring it back into navigation.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Routes deleted in V0.1.21 because they rendered invented data. */
const DELETED_ROUTES = [
  "/admin/users",
  "/admin/candy-ledger",
  "/admin/media",
  "/admin/moderation",
  "/dashboard/children",
] as const;

/** Where each deleted route's page file used to live. */
const DELETED_ROUTE_FILES = [
  "app/admin/users/page.tsx",
  "app/admin/candy-ledger/page.tsx",
  "app/admin/media/page.tsx",
  "app/admin/moderation/page.tsx",
  "app/(dashboard)/dashboard/children/page.tsx",
] as const;

describe("admin navigation", () => {
  it("lists no entry for a deleted mock page", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
    for (const route of DELETED_ROUTES) {
      expect(hrefs).not.toContain(route);
    }
  });

  it("keeps the real request fulfilment navigation intact", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
    // The fulfilment queue is the admin panel's reason to exist; the other
    // three are real database-backed surfaces that must not be removed by a
    // future mock cleanup.
    expect(hrefs).toContain("/admin/requests");
    expect(hrefs).toContain("/admin/examples");
    expect(hrefs).toContain("/admin/homepage");
    expect(hrefs).toContain("/admin/coupons");
    expect(hrefs).toContain("/admin/referrals");
  });

  it("keeps the self-labelled demo pages, which state on screen that they are نمایشی", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
    expect(hrefs).toContain("/admin/settings");
    expect(hrefs).toContain("/admin/characters");
  });

  it("has a label and a unique href for every entry", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.href.startsWith("/admin")).toBe(true);
    }
    expect(ADMIN_BRAND_HREF).toBe("/admin");
  });

  it("points every entry at a route file that actually exists", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      const routeDir = path.join(REPO_ROOT, "app", item.href.replace(/^\//, ""));
      expect(
        fs.existsSync(path.join(routeDir, "page.tsx")),
        `${item.href} has a nav entry but no page.tsx`,
      ).toBe(true);
    }
  });
});

describe("deleted mock routes", () => {
  it("no longer exist on disk", () => {
    for (const file of DELETED_ROUTE_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `${file} should be deleted`).toBe(false);
    }
  });

  it("is not linked from parent portal navigation either", () => {
    const hrefs = PARENT_NAV_ITEMS.map((i) => i.href);
    for (const route of DELETED_ROUTES) {
      expect(hrefs.some((h) => h.startsWith(route))).toBe(false);
    }
  });

  it("is not navigated to from any production source", () => {
    // Scans the shipped app/component/lib sources — not tests, which may
    // legitimately mention a path as a plain string (e.g. the unsafe-redirect
    // cases in login-destinations.spec.ts).
    //
    // Matches navigation intent specifically rather than any occurrence of
    // the path. A bare substring search false-positives on Supabase's GoTrue
    // Admin API, where `adminFetch("/admin/users")` resolves to
    // `<supabase-url>/auth/v1/admin/users` and has nothing to do with this
    // app's routes (lib/auth/dev-auth-admin.ts).
    const roots = ["app", "components", "lib"].map((d) => path.join(REPO_ROOT, d));
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, "utf-8");
        for (const route of DELETED_ROUTES) {
          const quoted = `["'\`]${route}(?:[/#?][^"'\`]*)?["'\`]`;
          const navigation = new RegExp(
            `(?:href=\\{?\\s*${quoted}|(?:push|replace|redirect|permanentRedirect)\\(\\s*${quoted})`,
          );
          if (navigation.test(source)) {
            offenders.push(`${path.relative(REPO_ROOT, full)} → ${route}`);
          }
        }
      }
    };

    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
