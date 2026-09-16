"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PARENT_NAV_ITEMS } from "@/lib/parent/navigation/parent-nav";
import { CREATION_CHOICES } from "@/lib/creation/creation-routes";
import type { ParentAccountSummary } from "@/lib/auth/parent-account";

/**
 * The signed-in parent's account control for the public site.
 *
 * Renders an avatar trigger in whichever header hosts it, and a right-side RTL
 * drawer with the parent portal destinations. The destinations come from the
 * shared navigation config rather than being restated here, so the drawer and
 * the portal's own navigation can never disagree — including on the absence of
 * a dashboard entry.
 *
 * Opening the drawer is the only thing the trigger does: it never navigates, so
 * a parent reading a marketing page is not thrown into /dashboard for clicking
 * their own name.
 */
export function ParentAccountDrawer({ account }: { account: ParentAccountSummary }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // A drawer that survived a route change would cover the page the parent just
  // asked for.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    // The page behind a modal drawer must not scroll with it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Focus moves into the drawer when it opens and returns to the trigger when
  // it closes, so keyboard users are never stranded behind the overlay.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      panelRef.current?.focus();
    } else if (!open && wasOpen.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls={drawerId}
        aria-haspopup="dialog"
        className="flex min-h-[44px] items-center gap-2 rounded-full border border-soft-border bg-white px-2 py-1 text-sm font-bold text-parent-navy transition-colors hover:border-candy-pink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink sm:pe-3"
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-candy-pink text-sm font-bold text-white"
        >
          {account.initials}
        </span>
        {/* The name is supporting detail: it is dropped on narrow screens
            where the avatar alone has to carry the signed-in state. */}
        <span className="hidden max-w-[12ch] truncate sm:inline">
          {account.displayName}
        </span>
        <span className="sr-only">باز کردن منوی حساب والد</span>
      </button>

      {/* Portalled to <body>. The homepage hero header carries a transform and
          a backdrop-filter, and either of those makes an element the containing
          block for its fixed descendants — which would trap this drawer inside
          the header bar instead of letting it cover the viewport. The portal is
          safe without a mounted guard because `open` starts false on the server
          and can only be set by a click, which is always post-hydration. */}
      {open && createPortal(
        <div className="fixed inset-0 z-[100]">
          {/* Clicking the page behind the drawer closes it. It is inert to
              assistive tech, which reaches the close button instead. */}
          <div
            className="absolute inset-0 bg-parent-navy/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <div
            id={drawerId}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="منوی حساب والد"
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-[min(20rem,86vw)] flex-col overflow-y-auto bg-white shadow-[0_0_40px_rgba(80,120,150,0.25)] focus:outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-soft-border px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-candy-pink text-base font-bold text-white"
                >
                  {account.initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-parent-navy">
                    {account.displayName}
                  </p>
                  <p className="text-xs text-text-dark/50">حساب والد</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-dark/60 hover:bg-soft-border/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink"
              >
                <span aria-hidden="true">✕</span>
                <span className="sr-only">بستن</span>
              </button>
            </div>

            <nav aria-label="بخش‌های حساب والد" className="flex flex-col px-3 py-2">
              {PARENT_NAV_ITEMS.map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-[44px] items-center rounded-lg px-2 text-sm font-medium text-text-dark hover:bg-soft-border/30 hover:text-candy-pink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* Creating is not account management, so it sits in its own block
                and links straight out to the public creation routes. */}
            <div className="mt-2 border-t border-soft-border px-3 pb-2 pt-3">
              <p className="px-2 pb-1 text-xs font-semibold text-text-dark/50">
                سفارش جدید
              </p>
              {CREATION_CHOICES.map((choice) => (
                <Link
                  key={choice.type}
                  href={choice.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm font-medium text-parent-navy hover:bg-candy-pink/10 hover:text-candy-pink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink"
                >
                  <span aria-hidden="true">{choice.icon}</span>
                  <span>{choice.label}</span>
                </Link>
              ))}
            </div>

            {/* The existing server logout: a real POST that clears the session
                cookie, not a client-side illusion of signing out. */}
            <form action="/api/logout" method="post" className="mt-auto border-t border-soft-border p-3">
              <button
                type="submit"
                className="min-h-[44px] w-full rounded-lg bg-soft-border/30 px-4 text-sm font-medium text-text-dark hover:bg-soft-border/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink"
              >
                خروج
              </button>
            </form>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
