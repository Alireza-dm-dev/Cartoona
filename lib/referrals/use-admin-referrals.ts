"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import type { AdminReferralListResponse } from "./admin-types"

export interface UseAdminReferralsResult {
  data: AdminReferralListResponse | null
  loading: boolean
  error: string | null
  page: number
  search: string
  setSearch: (s: string) => void
  setPage: (p: number) => void
  refresh: () => void
}

let abortController: AbortController | null = null

export function useAdminReferrals(pageSize = 25): UseAdminReferralsResult {
  const [data, setData] = useState<AdminReferralListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const mountedRef = useRef(true)
  const loadIdRef = useRef(0)

  const handleSetSearch = useCallback((s: string) => {
    setSearch(s)
    setPage(1)
  }, [])

  const doFetch = useRef((pg: number, srch: string) => {
    if (abortController) abortController.abort()
    abortController = new AbortController()
    const id = ++loadIdRef.current

    setLoading(true)
    setError(null)

    const params = new URLSearchParams()
    params.set("page", String(pg))
    params.set("pageSize", String(pageSize))
    if (srch) params.set("search", srch)

    fetch(`/api/admin/referrals?${params.toString()}`, {
      cache: "no-store",
      signal: abortController.signal,
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/admin-login?from=/admin/referrals"
          throw new Error("Unauthorized")
        }
        if (res.status === 403) {
          window.location.href = "/admin-login?from=/admin/referrals"
          throw new Error("Forbidden")
        }
        if (!res.ok) throw new Error("ADMIN_REFERRALS_LOAD_FAILED")
        return res.json() as Promise<AdminReferralListResponse>
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
    doFetch.current(page, search)
    return () => {
      mountedRef.current = false
      if (abortController) abortController.abort()
    }
  }, [page, search, pageSize])

  const refresh = useCallback(() => {
    doFetch.current(page, search)
  }, [page, search])

  return {
    data,
    loading,
    error,
    page,
    search,
    setSearch: handleSetSearch,
    setPage,
    refresh,
  }
}
