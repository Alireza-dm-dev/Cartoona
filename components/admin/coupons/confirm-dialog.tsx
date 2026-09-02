"use client"

import { useEffect, useRef, useId } from "react"

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Keyboard-accessible modal confirm dialog. Focus moves to the dialog on open,
 * Tab is trapped, Escape cancels, and focus returns to the trigger on close.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "انصراف",
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    prevFocusRef.current = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel()
      }
      if (e.key === "Tab") {
        const focusable = [cancelRef.current, confirmRef.current].filter(
          (el): el is HTMLButtonElement => el !== null && !el.disabled,
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      prevFocusRef.current?.focus()
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      aria-hidden="false"
    >
      <div
        className="absolute inset-0 bg-parent-navy/40"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative w-full max-w-md rounded-2xl border border-soft-border bg-white p-6 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-parent-navy">
          {title}
        </h2>
        <p id={descId} className="mt-2 text-sm text-text-dark/70">
          {description}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-xl border border-soft-border bg-white px-5 py-2.5 text-sm font-medium text-text-dark transition-all hover:bg-soft-border/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex items-center justify-center rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy disabled:opacity-50 disabled:cursor-not-allowed ${
              danger ? "bg-coral" : "bg-candy-pink"
            }`}
          >
            {loading ? "در حال اعمال..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
