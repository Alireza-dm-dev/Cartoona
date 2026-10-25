import "server-only"

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { callGet, callWrite, type CallFailure } from "@/lib/backend/call"
import type { AdminReferralListResponse, AdminReferralRelationship } from "@/lib/referrals/admin-types"
import type { ParentReferralSummary } from "@/lib/referrals/types"

/** Referrals through the backend (V0.1.53). No Supabase table or RPC. */

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export async function loadParentReferralSummary(context: VerifiedAuthContext): Promise<{ ok: true; summary: ParentReferralSummary } | CallFailure> {
  const r = await callGet(context, "parent_referrals", "/v1/parent/referrals")
  if (!r.ok) return r
  const b = r.body
  if (typeof b.referralCode !== "string") return { ok: false, kind: "unavailable", outcomeUnknown: false }
  return {
    ok: true,
    summary: {
      referralCode: b.referralCode,
      program: { isEnabled: b.isEnabled === true, rewardBasisPoints: num(b.rewardBasisPoints) },
      binding: { isBound: b.isBound === true, boundAt: typeof b.boundAt === "string" ? b.boundAt : null },
      referredCount: num(b.referredCount),
    },
  }
}

export async function bindReferralCode(context: VerifiedAuthContext, code: string): Promise<{ ok: true; status: string } | CallFailure> {
  const r = await callWrite(context, "referral_bind", "POST", "/v1/parent/referrals/bind", { code })
  if (!r.ok) return r
  return typeof r.body.status === "string" ? { ok: true, status: r.body.status } : { ok: false, kind: "unavailable", outcomeUnknown: true }
}

export async function loadAdminReferrals(
  context: VerifiedAuthContext,
  input: { search: string | undefined; page: number; pageSize: number },
): Promise<{ ok: true; response: AdminReferralListResponse } | CallFailure> {
  const r = await callGet(context, "admin_referrals", "/v1/admin/referrals", {
    search: input.search,
    page: String(input.page),
    pageSize: String(input.pageSize),
  })
  if (!r.ok) return r
  const o = r.body.overview as Record<string, unknown> | undefined
  const rels = r.body.relationships
  if (!o || !Array.isArray(rels)) return { ok: false, kind: "unavailable", outcomeUnknown: false }
  const total = num(r.body.total)
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
  const relationships: AdminReferralRelationship[] = rels.map((x: Record<string, unknown>) => ({
    id: String(x.id ?? ""),
    boundAt: String(x.boundAt ?? ""),
    bindingSource: String(x.bindingSource ?? "manual"),
    referralCodeSnapshot: String(x.referralCodeSnapshot ?? ""),
    referredParent: { name: str(x.referredName), email: str(x.referredEmail) },
    referrerParent: { name: str(x.referrerName), email: str(x.referrerEmail), currentCode: str(x.referrerCurrentCode) },
  }))
  return {
    ok: true,
    response: {
      settings: { isEnabled: o.isEnabled === true, rewardBasisPoints: num(o.rewardBasisPoints), updatedAt: String(o.settingsUpdatedAt ?? new Date(0).toISOString()) },
      metrics: {
        totalParentProfiles: num(o.totalParentProfiles),
        totalRelationships: num(o.totalRelationships),
        totalUnboundParentProfiles: num(o.totalUnboundParentProfiles),
        totalDeletedIdentityRelationships: num(o.totalDeletedIdentityRelationships),
        settingsHistoryCount: num(o.settingsHistoryCount),
      },
      relationships,
      pagination: { page: input.page, pageSize: input.pageSize, total, totalPages: total > 0 ? Math.ceil(total / input.pageSize) : 0 },
    },
  }
}

export async function updateReferralSettings(
  context: VerifiedAuthContext,
  body: { isEnabled: boolean; rewardBasisPoints: number; expectedUpdatedAt: string },
): Promise<{ ok: true; status: string; settings: { isEnabled: boolean; rewardBasisPoints: number; updatedAt: string } } | CallFailure> {
  const r = await callWrite(context, "admin_referral_settings", "PATCH", "/v1/admin/referrals/settings", body)
  if (!r.ok) return r
  if (typeof r.body.status !== "string") return { ok: false, kind: "unavailable", outcomeUnknown: true }
  return {
    ok: true,
    status: r.body.status,
    settings: { isEnabled: r.body.isEnabled === true, rewardBasisPoints: num(r.body.rewardBasisPoints), updatedAt: String(r.body.updatedAt ?? "") },
  }
}
