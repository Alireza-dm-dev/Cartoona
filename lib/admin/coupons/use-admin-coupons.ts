"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import type { AdminCouponListResponse } from "@/lib/admin/coupons/types"

export interface UseAdminCouponsResult {
  data: AdminCouponListResponse | null
  loading: boolean
  error: string | null
  page: number
  search: string
  status: string
  discountType: string
  setSearch: (s: string) => void
  setStatus: (s: string) => void
  setDiscountType: (s: string) => void
  setPage: (p: number) => void
  refresh: () => void
}

let abortController: AbortController | null = null

export function useAdminCoupons(pageSize = 25): UseAdminCouponsResult {
  const [data, setData] = useState<AdminCouponListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [discountType, setDiscountType] = useState("all")
  const mountedRef = useRef(true)
  const loadIdRef = useRef(0)

  const handleSetSearch = useCallback((s: string) => {
    setSearch(s)
    setPage(1)
  }, [])

  const handleSetStatus = useCallback((s: string) => {
    setStatus(s)
    setPage(1)
  }, [])

  const handleSetDiscountType = useCallback((s: string) => {
    setDiscountType(s)
    setPage(1)
  }, [])

  const doFetch = useRef((pg: number, srch: string, st: string, dt: string) => {
    if (abortController) abortController.abort()
    abortController = new AbortController()
    const id = ++loadIdRef.current

    setLoading(true)
    setError(null)

    const params = new URLSearchParams()
    params.set("page", String(pg))
    params.set("pageSize", String(pageSize))
    if (srch) params.set("search", srch)
    if (st && st !== "all") params.set("status", st)
    if (dt && dt !== "all") params.set("discountType", dt)

    fetch(`/api/admin/coupons?${params.toString()}`, {
      cache: "no-store",
      signal: abortController.signal,
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/admin-login?from=/admin/coupons"
          throw new Error("Unauthorized")
        }
        if (res.status === 403) {
          window.location.href = "/admin-login?from=/admin/coupons"
          throw new Error("Forbidden")
        }
        if (!res.ok) throw new Error("ADMIN_COUPONS_LOAD_FAILED")
        return res.json() as Promise<AdminCouponListResponse>
      })
      .then((result) => {
        if (mountedRef.current && id === loadIdRef.current) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return
        if (mountedRef.current && id === loadIdRef.current) {
          setError("بارگذاری اطلاعات انجام نشد. دوباره تلاش کنید.")
          setLoading(false)
        }
      })
  })

  useEffect(() => {
    mountedRef.current = true
    doFetch.current(page, search, status, discountType)
    return () => {
      mountedRef.current = false
      if (abortController) abortController.abort()
    }
  }, [page, search, status, discountType, pageSize])

  const refresh = useCallback(() => {
    doFetch.current(page, search, status, discountType)
  }, [page, search, status, discountType])

  return {
    data,
    loading,
    error,
    page,
    search,
    status,
    discountType,
    setSearch: handleSetSearch,
    setStatus: handleSetStatus,
    setDiscountType: handleSetDiscountType,
    setPage,
    refresh,
  }
}
