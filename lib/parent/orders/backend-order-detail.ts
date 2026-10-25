import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendGetJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId } from "@/lib/observability/request-context";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createPrivateSignedUrls } from "@/lib/storage/private-signed-url";
import { mapBackendRejection, verifyParentCaller, type BackendParentRejection, type ParentBackendFailure } from "../backend-caller";
import type { ParentOrderDetailResult } from "./detail-types";
import { assembleParentOrderDetail, isValidOrderId, type BackendOrderDetail } from "./detail-queries";

/**
 * The parent order DETAIL through the backend (V0.1.52).
 *
 *   verifyParentCaller()  ->  GET /v1/parent/orders/:orderId  (ownership, metadata, history in PostgreSQL)
 *                         ->  Supabase Storage ONLY to sign the source-file keys the backend returned
 *
 * No Supabase table or RPC is read. The signing keys come from PostgreSQL rows
 * that were selected AFTER the ownership check, so another parent's keys are
 * never even in this process. A Storage outage degrades each preview to
 * `signedUrl: null` (a retryable unavailable state); the metadata still shows
 * and nobody is signed out.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

type Outcome =
  | { kind: "detail"; data: BackendOrderDetail }
  | { kind: "rejected"; error: string };

const REJECTIONS: Record<number, readonly string[]> = {
  401: ["unauthenticated", "session_expired", "session_invalidated"],
  403: ["identity_not_linked", "forbidden"],
  404: ["not_found", "parent_profile_not_found"],
};

const opt = (v: unknown, max = 20_000): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > max) throw new Error("string");
  return v;
};
const optInt = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("int");
  return v;
};

function parseDetail(json: unknown, status: number): Outcome {
  const body = (json ?? {}) as Record<string, unknown>;
  if (status !== 200) {
    if (typeof body.error === "string" && REJECTIONS[status]?.includes(body.error)) return { kind: "rejected", error: body.error };
    throw new Error("unexpected backend body");
  }
  const o = (body.order ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !UUID.test(o.id)) throw new Error("order.id");
  if (typeof o.type !== "string" || typeof o.status !== "string") throw new Error("order.type");
  if (typeof o.created_at !== "string" || !TIMESTAMP.test(o.created_at)) throw new Error("order.created_at");
  if (typeof o.candy_cost !== "number" || !Number.isSafeInteger(o.candy_cost)) throw new Error("order.candy_cost");
  if (o.video_characters_speak !== null && o.video_characters_speak !== undefined && typeof o.video_characters_speak !== "boolean") throw new Error("speak");
  if (!Array.isArray(body.sourceMedia) || body.sourceMedia.length > 200) throw new Error("sourceMedia");
  if (!Array.isArray(body.history) || body.history.length > 500) throw new Error("history");

  const sourceMedia = body.sourceMedia.map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (typeof m.id !== "string" || !UUID.test(m.id)) throw new Error("media.id");
    if (typeof m.uploadedAt !== "string" || !TIMESTAMP.test(m.uploadedAt)) throw new Error("media.uploadedAt");
    if (typeof m.path !== "string" || m.path.length === 0 || m.path.length > 512) throw new Error("media.path");
    return { id: m.id, mimeType: opt(m.mimeType, 100), uploadedAt: m.uploadedAt, path: m.path };
  });
  const history = body.history.map((raw) => {
    const h = (raw ?? {}) as Record<string, unknown>;
    if (typeof h.new_status !== "string" || typeof h.created_at !== "string" || !TIMESTAMP.test(h.created_at)) throw new Error("history");
    return {
      previous_status: opt(h.previous_status, 40),
      new_status: h.new_status,
      parent_visible_note: opt(h.parent_visible_note, 4000),
      created_at: h.created_at,
    };
  });
  let finalMedia: BackendOrderDetail["finalMedia"] = null;
  if (body.finalMedia !== null && body.finalMedia !== undefined) {
    const f = body.finalMedia as Record<string, unknown>;
    if (typeof f.id !== "string" || !UUID.test(f.id)) throw new Error("final.id");
    finalMedia = { id: f.id, mimeType: opt(f.mimeType, 100), fileName: opt(f.fileName, 255) };
  }
  return {
    kind: "detail",
    data: {
      order: {
        id: o.id,
        type: o.type,
        status: o.status,
        title: opt(o.title, 2000),
        description: opt(o.description),
        child_name: opt(o.child_name, 2000),
        candy_cost: o.candy_cost,
        created_at: o.created_at,
        character_name: opt(o.character_name, 500),
        video_script: opt(o.video_script),
        video_style: opt(o.video_style, 2000),
        video_duration_seconds: optInt(o.video_duration_seconds),
        video_duration_choice: opt(o.video_duration_choice, 40),
        video_characters_speak: (o.video_characters_speak ?? null) as boolean | null,
        drawing_animation_style: opt(o.drawing_animation_style, 2000),
      },
      sourceMedia,
      history,
      finalMedia,
    },
  };
}

export type ParentOrderDetailLoad =
  | ParentOrderDetailResult
  | { ok: false; reason: "unauthenticated" | "no_parent_profile" | ParentBackendFailure | "auth_unavailable" };

/** Step 1 for the page: verify the session so a signed-out visitor is redirected before any read. */
export const verifyParentOrderDetailCaller = verifyParentCaller;

/** Step 2: the backend read + source-media signing for a verified caller. */
export async function fetchParentOrderDetail(context: VerifiedAuthContext, orderId: string): Promise<ParentOrderDetailLoad> {
  if (!isValidOrderId(orderId)) return { ok: false, reason: "not_found" };
  let outcome: Outcome;
  try {
    ({ data: outcome } = await backendGetJson({
      operation: "parent_order_detail",
      path: `/v1/parent/orders/${orderId.trim().toLowerCase()}`,
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: [401, 403, 404],
      parse: parseDetail,
    }));
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, reason: "read_failed" };
    throw error;
  }
  if (outcome.kind === "rejected") {
    if (outcome.error === "not_found") return { ok: false, reason: "not_found" };
    const mapped = mapBackendRejection(outcome.error as BackendParentRejection);
    return { ok: false, reason: mapped === "service_unavailable" ? "read_failed" : mapped };
  }

  // Storage is bytes only: sign the keys PostgreSQL authorized. Failure => null URLs.
  let signed = new Map<string, string | null>();
  if (outcome.data.sourceMedia.length > 0) {
    try {
      const supabase = await createServerSupabaseClient();
      signed = await createPrivateSignedUrls(supabase, outcome.data.sourceMedia.map((m) => m.path));
    } catch {
      signed = new Map();
    }
  }
  const detail = assembleParentOrderDetail(outcome.data, signed);
  if (!detail) return { ok: false, reason: "not_found" };
  return { ok: true, detail };
}
