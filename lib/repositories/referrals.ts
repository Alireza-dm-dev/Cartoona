import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Referrals on plain PostgreSQL (V0.1.53). Every statement is one existing
 * trusted function (0005, EXECUTE granted by 0019) that re-checks the caller's
 * role in the database. There is no referral reward in the schema (a referral
 * is a one-time binding plus the program setting), so nothing here moves
 * candy. Timestamps are microsecond UTC text: the settings `updatedAt` is the
 * optimistic-concurrency token and must round-trip byte for byte.
 */

export interface ReferralSummaryRow {
  referral_code: string;
  is_enabled: boolean;
  reward_basis_points: number;
  is_bound: boolean;
  bound_at: string | null;
  referred_count: string;
}

/** Null = not a parent / no profile (the function returns no row). */
export async function getParentReferralSummary(db: Queryable, input: { userId: string }): Promise<ReferralSummaryRow | null> {
  const rows = await runQuery<ReferralSummaryRow>(
    db,
    `SELECT referral_code, is_enabled, reward_basis_points, is_bound,
            CASE WHEN bound_at IS NULL THEN NULL ELSE to_char(bound_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS bound_at, referred_count
     FROM public.get_parent_referral_summary_trusted($1)`,
    [requireUuid(input.userId, "userId")],
  );
  return rows[0] ?? null;
}

export async function bindParentReferralCode(
  db: Queryable,
  input: { userId: string; code: string },
): Promise<{ status: string; bound_at: string | null }> {
  const rows = await runQuery<{ status: string; bound_at: string | null }>(
    db,
    `SELECT status, CASE WHEN bound_at IS NULL THEN NULL ELSE to_char(bound_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS bound_at
     FROM public.bind_parent_referral_code_trusted($1, $2)`,
    [requireUuid(input.userId, "userId"), input.code],
  );
  if (!rows[0]) throw new TypeError("bind_parent_referral_code_trusted returned no row");
  return rows[0];
}

export interface AdminReferralOverviewRow {
  is_enabled: boolean;
  reward_basis_points: number;
  settings_updated_at: string;
  total_parent_profiles: string;
  total_referral_relationships: string;
  total_unbound_parent_profiles: string;
  total_deleted_identity_relationships: string;
  settings_history_count: string;
}

export async function getAdminReferralOverview(db: Queryable, input: { adminUserId: string }): Promise<AdminReferralOverviewRow | null> {
  const rows = await runQuery<AdminReferralOverviewRow>(
    db,
    `SELECT is_enabled, reward_basis_points, to_char(settings_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS settings_updated_at, total_parent_profiles,
            total_referral_relationships, total_unbound_parent_profiles, total_deleted_identity_relationships, settings_history_count
     FROM public.get_admin_referral_overview_trusted($1)`,
    [requireUuid(input.adminUserId, "adminUserId")],
  );
  return rows[0] ?? null;
}

export interface AdminReferralRelationshipRow {
  relationship_id: string;
  bound_at: string;
  binding_source: string;
  referral_code_snapshot: string;
  referred_parent_name: string | null;
  referred_parent_email: string | null;
  referrer_parent_name: string | null;
  referrer_parent_email: string | null;
  referrer_current_code: string | null;
  total_count: string;
}

export async function listAdminReferralRelationships(
  db: Queryable,
  input: { adminUserId: string; search: string | null; limit: number; offset: number },
): Promise<AdminReferralRelationshipRow[]> {
  return runQuery<AdminReferralRelationshipRow>(
    db,
    `SELECT relationship_id, to_char(bound_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS bound_at, binding_source, referral_code_snapshot, referred_parent_name,
            referred_parent_email, referrer_parent_name, referrer_parent_email, referrer_current_code, total_count
     FROM public.get_admin_referral_relationships_trusted($1, $2, $3, $4)`,
    [requireUuid(input.adminUserId, "adminUserId"), input.search, input.limit, input.offset],
  );
}

export interface ReferralSettingsResult {
  status: string;
  is_enabled: boolean;
  reward_basis_points: number;
  updated_at: string;
}

export async function updateReferralProgramSettings(
  db: Queryable,
  input: { adminUserId: string; isEnabled: boolean; rewardBasisPoints: number; expectedUpdatedAt: string },
): Promise<ReferralSettingsResult> {
  const rows = await runQuery<ReferralSettingsResult>(
    db,
    `SELECT status, is_enabled, reward_basis_points, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at
     FROM public.update_admin_referral_program_settings_trusted($1, $2, $3, $4::timestamptz)`,
    [requireUuid(input.adminUserId, "adminUserId"), input.isEnabled, input.rewardBasisPoints, input.expectedUpdatedAt],
  );
  if (!rows[0]) throw new TypeError("update_admin_referral_program_settings_trusted returned no row");
  return rows[0];
}
