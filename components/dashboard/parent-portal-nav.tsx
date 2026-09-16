"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PARENT_NAV_ITEMS,
  isParentNavItemActive,
} from "@/lib/parent/navigation/parent-nav";

/**
 * Parent portal navigation, desktop and mobile.
 *
 * The previous nav was `hidden sm:flex`, which left phones with no navigation
 * at all. This renders an inline row on wide screens and a disclosure menu
 * below `sm`, both from the same item list so they cannot drift.
 */
export function ParentPortalNav({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  // A navigation that stayed open across a route change would cover the page
  // the parent just asked for, so each entry closes it on the way out.
  const [open, setOpen] = useState(false);

  return (
    <>
      <nav
        aria-label="منوی پنل والدین"
        className="hidden items-center gap-5 text-sm font-medium text-text-dark/70 sm:flex"
      >
        {PARENT_NAV_ITEMS.map((item) => {
          const active = isParentNavItemActive(item, pathname);
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "text-candy-pink"
                  : "hover:text-text-dark transition-colors"
              }
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="parent-mobile-nav"
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-soft-border px-3 text-sm font-medium text-text-dark sm:hidden"
      >
        <span className="sr-only">منوی پنل والدین</span>
        <span aria-hidden="true">{open ? "✕" : "☰"}</span>
      </button>

      {open && (
        <div
          id="parent-mobile-nav"
          className="absolute inset-x-0 top-full z-50 border-b border-soft-border bg-white shadow-sm sm:hidden"
        >
          <nav aria-label="منوی پنل والدین" className="flex flex-col px-6 py-2">
            {PARENT_NAV_ITEMS.map((item) => {
              const active = isParentNavItemActive(item, pathname);
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex min-h-[44px] items-center border-b border-soft-border/40 text-sm font-medium ${
                    active ? "text-candy-pink" : "text-text-dark/80"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {children}
          </nav>
        </div>
      )}
    </>
  );
}
