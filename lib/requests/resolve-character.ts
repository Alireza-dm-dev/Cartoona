import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Turn the character a parent picked into the id the request RPC needs.
 *
 * The public creation forms are anonymous and render `config/characters.ts`
 * directly, so no database round trip is needed to show the cast. What they
 * store in the draft is therefore the character's NAME. The trusted RPC, on the
 * other hand, takes `p_character_id UUID` and checks it against an active row
 * in `public.characters`.
 *
 * Something has to bridge the two, and it has to be the server: a name arriving
 * from a draft is untrusted input, and the id it maps to decides which row the
 * order points at. Doing it here keeps the anonymous pages free of a database
 * dependency while the authoritative lookup still happens somewhere the browser
 * cannot influence.
 *
 * A draft that already carries a UUID is passed through unchanged, so a future
 * form that stores ids directly needs no change here.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ResolveCharacterResult =
  | { ok: true; characterId: string | null }
  | { ok: false; reason: "not_found" | "read_failed" }

export function looksLikeCharacterId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

export async function resolveCharacterId(
  supabase: SupabaseClient,
  nameOrId: string | null,
): Promise<ResolveCharacterResult> {
  // Requests that legitimately carry no character (drawing animation) resolve
  // to null rather than to a failure.
  if (nameOrId === null || nameOrId.trim().length === 0) {
    return { ok: true, characterId: null }
  }

  const value = nameOrId.trim()

  // Already an id: the RPC still verifies it exists and is active, so nothing
  // is taken on trust by returning it here.
  if (looksLikeCharacterId(value)) return { ok: true, characterId: value }

  const { data, error } = await supabase
    .from("characters")
    .select("id")
    .eq("name", value)
    .eq("is_active", true)
    .maybeSingle()

  if (error) return { ok: false, reason: "read_failed" }
  if (!data?.id || typeof data.id !== "string") return { ok: false, reason: "not_found" }

  return { ok: true, characterId: data.id }
}
