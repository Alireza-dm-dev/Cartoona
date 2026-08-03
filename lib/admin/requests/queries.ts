import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderStatus, OrderType } from "@/types/app"
import type {
  AdminMediaAssetInfo,
  AdminOrderDetail,
  AdminParentInfo,
  AdminQueueResult,
  AdminTypeDetailRow,
} from "@/lib/admin/requests/types"
import { mapMediaAsset, mapOrderDetail, mapQueueRow } from "@/lib/admin/requests/mappers"
import { clampPage } from "@/lib/admin/requests/validation"
import { createPrivateSignedUrl } from "@/lib/storage/private-signed-url"

interface OrderParentJoin {
  id: string
  type: string
  status: string
  title: string
  description: string | null
  candy_cost: number
  moderation_status: string
  created_at: string
  updated_at: string
  character_id: string | null
  parent_profiles:
    | {
        id: string
        full_name: string
        user_id: string
        users: { email: string | null } | null
      }
    | null
}

interface OrderDetailRow extends OrderParentJoin {
  characters: { name: string } | null
  media_assets: Array<{
    id: string
    type: string
    file_url: string
    mime_type: string | null
    created_at: string
  }>
}

export interface QueueQueryInput {
  type: OrderType | null
  status: OrderStatus | null
  page: number
  pageSize: number
}

export async function queryAdminRequestQueue(
  supabase: SupabaseClient,
  input: QueueQueryInput,
): Promise<AdminQueueResult | null> {
  const from = (input.page - 1) * input.pageSize
  const to = from + input.pageSize - 1

  let query = supabase
    .from("orders")
    .select(
      "id, type, status, title, candy_cost, created_at, updated_at, parent_id, parent_profiles(id, full_name, user_id, users(id, email))",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to)

  if (input.type) query = query.eq("type", input.type)
  if (input.status) query = query.eq("status", input.status)

  const { data, error, count } = await query

  if (error) return null

  const total = count ?? 0
  const totalPages = Math.max(1, Math.ceil(total / input.pageSize))
  const safePage = clampPage(input.page, totalPages)

  const rows = (data ?? []).map((order) => {
    const rawProfile = order.parent_profiles
    const profile = Array.isArray(rawProfile) ? (rawProfile[0] ?? null) : rawProfile
    return mapQueueRow({
      id: order.id,
      type: order.type,
      status: order.status,
      title: order.title,
      candy_cost: order.candy_cost,
      created_at: order.created_at,
      updated_at: order.updated_at,
      parentFullName: profile?.full_name ?? null,
      parentProfileMissing: profile === null,
      childProfileId: null,
    })
  })

  return {
    rows,
    pagination: {
      page: safePage,
      pageSize: input.pageSize,
      total,
      totalPages,
    },
    hasFilters: input.type !== null || input.status !== null,
  }
}

export interface DetailQueryInput {
  requestId: string
}

export async function queryAdminRequestDetail(
  supabase: SupabaseClient,
  input: DetailQueryInput,
): Promise<AdminOrderDetail | null> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "id, type, status, title, description, candy_cost, moderation_status, created_at, updated_at, character_id, parent_id, parent_profiles(id, full_name, user_id, users(id, email)), characters(id, name), media_assets(id, type, file_url, mime_type, created_at)",
    )
    .eq("id", input.requestId)
    .maybeSingle()

  if (error || !order) return null

  const detailRow = order as unknown as OrderDetailRow
  const profile = detailRow.parent_profiles

  const parent: AdminParentInfo = profile
    ? {
        name: profile.full_name || null,
        email: profile.users?.email ?? null,
        deleted: false,
      }
    : { name: null, email: null, deleted: true }

  // Type-specific extension row
  let typeRows: AdminTypeDetailRow[] = []
  if (detailRow.type === "video") {
    const { data: video } = await supabase
      .from("video_requests")
      .select("script, style, duration_seconds")
      .eq("order_id", detailRow.id)
      .maybeSingle()
    const referenceFile = detailRow.media_assets.some((m) => m.type === "upload")
    typeRows = [
      { label: "سناریو", value: video?.script?.trim() || "ثبت نشده", multiline: true },
      { label: "سبک ویدیو", value: video?.style?.trim() || "ثبت نشده" },
      {
        label: "مدت زمان",
        value: video?.duration_seconds ? `${video.duration_seconds} ثانیه` : "ثبت نشده",
      },
      { label: "فایل مرجع", value: referenceFile ? "بارگذاری شده" : "بارگذاری نشده" },
    ]
  } else if (detailRow.type === "drawing_animation") {
    const { data: drawing } = await supabase
      .from("drawing_animation_requests")
      .select("upload_url, animation_style")
      .eq("order_id", detailRow.id)
      .maybeSingle()
    const sourceDrawing = Boolean(drawing?.upload_url) || detailRow.media_assets.some((m) => m.type === "upload")
    typeRows = [
      { label: "سبک انیمیشن", value: drawing?.animation_style?.trim() || "ثبت نشده" },
      { label: "نقاشی منبع", value: sourceDrawing ? "بارگذاری شده" : "بارگذاری نشده" },
    ]
  } else if (detailRow.type === "image") {
    const referenceFile = detailRow.media_assets.some((m) => m.type === "upload")
    typeRows = [{ label: "فایل مرجع", value: referenceFile ? "بارگذاری شده" : "بارگذاری نشده" }]
  }

  // Short-lived signed URLs for source media only. Final deliverables are
  // handled by the dedicated fulfilment read (loadAdminFinalMedia) and never
  // shown in this section.
  const media: AdminMediaAssetInfo[] = []
  for (const asset of detailRow.media_assets) {
    if (asset.type !== "upload") continue
    const signedUrl = await createPrivateSignedUrl(supabase, asset.file_url)
    media.push(mapMediaAsset(asset, signedUrl))
  }

  const childProfileId = null // no child_profile_id column exists in orders today

  return mapOrderDetail({
    id: detailRow.id,
    type: detailRow.type,
    status: detailRow.status,
    title: detailRow.title,
    description: detailRow.description,
    candy_cost: detailRow.candy_cost,
    moderation_status: detailRow.moderation_status,
    created_at: detailRow.created_at,
    updated_at: detailRow.updated_at,
    parentFullName: parent.name,
    parentEmail: parent.email,
    parentProfileMissing: parent.deleted,
    childProfileId,
    characterName: detailRow.characters?.name ?? null,
    consentGranted: false, // consent snapshot not stored on orders today
    typeRows,
    media,
  })
}
