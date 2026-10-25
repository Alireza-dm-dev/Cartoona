import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Examples CMS on plain PostgreSQL (V0.1.53). Reads are SELECTs (public: the
 * published ones only; admin: all). Every write is one of the narrow trusted
 * functions of migration 0019 (admin role re-checked, input validated, a single
 * table); the application role has no INSERT/UPDATE/DELETE on `examples`.
 * `media_url` is an object KEY in the example-media bucket; the bytes stay in Storage.
 */

export interface ExampleRow {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  character_id: string | null;
  media_url: string;
  thumbnail_url: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  badge_label: string;
}

export async function listExamples(db: Queryable, input: { publishedOnly: boolean }): Promise<ExampleRow[]> {
  return runQuery<ExampleRow>(
    db,
    `SELECT e.id, e.kind, e.title, e.description, e.character_id, e.media_url, e.thumbnail_url, e.is_published, e.sort_order,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
  to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at, e.badge_label FROM public.examples e WHERE ($1::boolean = false OR e.is_published = true)
     ORDER BY e.sort_order ASC, e.created_at DESC, e.id ASC`,
    [input.publishedOnly],
  );
}

export async function getExample(db: Queryable, id: string): Promise<ExampleRow | null> {
  const rows = await runQuery<ExampleRow>(db, `SELECT e.id, e.kind, e.title, e.description, e.character_id, e.media_url, e.thumbnail_url, e.is_published, e.sort_order,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
  to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at, e.badge_label FROM public.examples e WHERE e.id = $1`, [requireUuid(id, "exampleId")]);
  return rows[0] ?? null;
}

export interface CreateExampleInput {
  adminUserId: string;
  id: string;
  kind: string;
  title: string;
  badgeLabel: string;
  description: string;
  mediaUrl: string;
  isPublished: boolean;
  sortOrder: number;
}

export async function createExample(db: Queryable, i: CreateExampleInput): Promise<ExampleRow> {
  const rows = await runQuery<ExampleRow>(
    db,
    `SELECT e.id, e.kind, e.title, e.description, e.character_id, e.media_url, e.thumbnail_url, e.is_published, e.sort_order,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
  to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at, e.badge_label FROM public.create_example_trusted($1, $2, $3, $4, $5, $6, $7, $8, $9) e`,
    [requireUuid(i.adminUserId, "adminUserId"), requireUuid(i.id, "exampleId"), i.kind, i.title, i.badgeLabel, i.description, i.mediaUrl, i.isPublished, i.sortOrder],
  );
  return rows[0];
}

export async function updateExample(db: Queryable, input: { adminUserId: string; id: string; fields: Record<string, unknown> }): Promise<ExampleRow> {
  const rows = await runQuery<ExampleRow>(db, `SELECT e.id, e.kind, e.title, e.description, e.character_id, e.media_url, e.thumbnail_url, e.is_published, e.sort_order,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
  to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at, e.badge_label FROM public.update_example_trusted($1, $2, $3::jsonb) e`, [
    requireUuid(input.adminUserId, "adminUserId"),
    requireUuid(input.id, "exampleId"),
    JSON.stringify(input.fields),
  ]);
  return rows[0];
}

export async function replaceExampleMedia(
  db: Queryable,
  input: { adminUserId: string; id: string; mediaUrl: string },
): Promise<{ example: ExampleRow; previous_media_url: string | null }> {
  const rows = await runQuery<{ r: { example: ExampleRow; previous_media_url: string | null } }>(
    db,
    `SELECT public.replace_example_media_trusted($1, $2, $3) AS r`,
    [requireUuid(input.adminUserId, "adminUserId"), requireUuid(input.id, "exampleId"), input.mediaUrl],
  );
  return rows[0].r;
}

export async function deleteExample(db: Queryable, input: { adminUserId: string; id: string }): Promise<ExampleRow> {
  const rows = await runQuery<{ r: ExampleRow }>(db, `SELECT public.delete_example_trusted($1, $2) AS r`, [
    requireUuid(input.adminUserId, "adminUserId"),
    requireUuid(input.id, "exampleId"),
  ]);
  return rows[0].r;
}
