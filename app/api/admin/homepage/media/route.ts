import {
  mediaJson,
  queryAdminHomepageMedia,
  requireAdminHomepageAuth,
} from "@/lib/admin/homepage/media-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/homepage/media
 * Admin-only media overview: per-slot previews + metadata, current hero TV
 * rect with its revision, and whether hero/sections share one object.
 * Storage keys are never exposed — only resolved preview URLs.
 */
export async function GET() {
  const auth = await requireAdminHomepageAuth();
  if (!auth.ok) return auth.response;

  const overview = await queryAdminHomepageMedia(auth.supabase);
  return mediaJson(overview);
}
