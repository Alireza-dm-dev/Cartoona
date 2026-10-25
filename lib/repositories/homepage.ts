import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Homepage CMS on plain PostgreSQL (V0.1.53). Reads are three SELECTs (the
 * singleton content row, the per-slot media metadata, the hero layout); every
 * write is an existing trusted function (0005, EXECUTE by 0019) that re-checks
 * the admin role and enforces revision-based optimistic concurrency. A media
 * row holds an object KEY; the bytes stay in Storage.
 */

export interface HomepageContentRow {
  content_json: unknown;
  revision: number;
}

export async function getHomepageContentRow(db: Queryable): Promise<HomepageContentRow | null> {
  const rows = await runQuery<HomepageContentRow>(
    db,
    `SELECT content_json, revision FROM public.homepage_content WHERE singleton_key = 'homepage'`,
  );
  return rows[0] ?? null;
}

export interface HomepageMediaRow {
  slot_key: string;
  media_type: string;
  storage_path: string;
  mime_type: string;
  byte_size: string;
  width: number | null;
  height: number | null;
  duration_seconds: string | null;
  updated_at: string;
}

export async function listHomepageMediaRows(db: Queryable): Promise<HomepageMediaRow[]> {
  return runQuery<HomepageMediaRow>(
    db,
    `SELECT slot_key, media_type, storage_path, mime_type, byte_size, width, height, duration_seconds, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at
     FROM public.homepage_media_assets ORDER BY slot_key`,
  );
}

export async function getHeroLayoutRow(db: Queryable): Promise<{ tv_rect: unknown; revision: number } | null> {
  const rows = await runQuery<{ tv_rect: unknown; revision: number }>(
    db,
    `SELECT tv_rect, revision FROM public.homepage_hero_layout WHERE singleton_key = 'hero'`,
  );
  return rows[0] ?? null;
}

export async function updateHomepageContent(
  db: Queryable,
  input: { adminUserId: string; content: unknown; expectedRevision: number },
): Promise<{ content_json: unknown; revision: number; updated_at: string }> {
  const rows = await runQuery<{ result: { content_json: unknown; revision: number; updated_at: string } }>(
    db,
    `SELECT public.update_homepage_content_trusted($1, $2::jsonb, $3) AS result`,
    [requireUuid(input.adminUserId, "adminUserId"), JSON.stringify(input.content), input.expectedRevision],
  );
  return rows[0].result;
}

export interface RecordHomepageMediaInput {
  adminUserId: string;
  slot: string;
  mediaType: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  tvRect: unknown | null;
  expectedLayoutRevision: number | null;
  applyToSections: boolean;
}

export async function recordHomepageMediaReplacement(db: Queryable, input: RecordHomepageMediaInput): Promise<unknown> {
  const rows = await runQuery<{ result: unknown }>(
    db,
    `SELECT public.record_homepage_media_replacement_trusted($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb, $10, $11) AS result`,
    [
      requireUuid(input.adminUserId, "adminUserId"),
      input.slot,
      input.mediaType,
      input.storagePath,
      input.mimeType,
      input.byteSize,
      input.width,
      input.height,
      input.tvRect === null ? null : JSON.stringify(input.tvRect),
      input.expectedLayoutRevision,
      input.applyToSections,
    ],
  );
  return rows[0].result;
}

export async function deleteHomepageMedia(db: Queryable, input: { adminUserId: string; slot: string }): Promise<unknown> {
  const rows = await runQuery<{ result: unknown }>(db, `SELECT public.delete_homepage_media_trusted($1, $2) AS result`, [
    requireUuid(input.adminUserId, "adminUserId"),
    input.slot,
  ]);
  return rows[0].result;
}

export async function updateHeroLayout(
  db: Queryable,
  input: { adminUserId: string; rect: unknown; expectedRevision: number },
): Promise<unknown> {
  const rows = await runQuery<{ result: unknown }>(db, `SELECT public.update_homepage_hero_layout_trusted($1, $2::jsonb, $3) AS result`, [
    requireUuid(input.adminUserId, "adminUserId"),
    JSON.stringify(input.rect),
    input.expectedRevision,
  ]);
  return rows[0].result;
}
