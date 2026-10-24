import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Parent request submission on plain PostgreSQL (V0.1.50).
 *
 * The ONE write is public.create_parent_request_trusted (migration 0005, EXECUTE
 * granted to the app role by 0016): one call, one transaction, and it alone
 * inserts the order and its child rows, spends the welcome credit OR the candy,
 * and writes the ledger. The app role has no INSERT/UPDATE on any of those
 * tables, so there is no other way to create or charge a request from here.
 *
 * Callers pass the parent profile id they resolved for the signed-in user
 * (`findParentProfileIdByUserId`); nothing here accepts a user id, role,
 * price, wallet or balance.
 */

export interface CreateParentRequestInput {
  parentProfileId: string;
  /** Server-minted (the storage path embeds it). */
  orderId: string;
  type: "image" | "video" | "drawing_animation";
  title: string | null;
  description: string | null;
  characterId: string | null;
  durationKey: string | null;
  videoScript: string | null;
  videoStyle: string | null;
  animationStyle: string | null;
  durationChoice: string | null;
  charactersSpeak: boolean | null;
  childName: string | null;
  /** The idempotency key of this logical submission. */
  submissionKey: string;
  /** Storage object key of the source file, already verified by the BFF; null = no file. */
  filePath: string | null;
  /** MIME type of that object as the storage provider recorded it. Null iff filePath is null. */
  fileMimeType: string | null;
  originalFilename: string | null;
}

export interface CreatedParentRequest {
  orderId: string;
  type: string;
  status: string;
  candyCost: number;
  /** True when this submission key had already created the order (the ORIGINAL order is returned). */
  replayed: boolean;
  paymentSource: string;
}

const CREATE_REQUEST = `
  SELECT id, type, status, candy_cost, replayed, payment_source
  FROM public.create_parent_request_trusted(
    $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::uuid, $7::text, $8::text,
    $9::text, $10::text, $11::text, $12::text, $13::boolean, $14::text, $15::text,
    $16::uuid, $17::text)`;

interface CreatedRow {
  id: unknown;
  type: unknown;
  status: unknown;
  candy_cost: unknown;
  replayed: unknown;
  payment_source: unknown;
}

function toCreated(row: CreatedRow | undefined): CreatedParentRequest {
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.type !== "string" ||
    typeof row.status !== "string" ||
    typeof row.candy_cost !== "number" ||
    typeof row.replayed !== "boolean" ||
    typeof row.payment_source !== "string"
  ) {
    throw new TypeError("create_parent_request_trusted returned an unexpected row");
  }
  return {
    orderId: row.id,
    type: row.type,
    status: row.status,
    candyCost: row.candy_cost,
    replayed: row.replayed,
    paymentSource: row.payment_source,
  };
}

/**
 * Create (or replay) a request. A database failure throws `DbError`; a rule
 * the function refuses throws `DbError{kind:"business"}` whose `businessCode`
 * is the function's own token (`INSUFFICIENT_CANDIES`, `request_consent_required`,
 * ...). Nothing is written when it throws: the function is one transaction.
 */
export async function createParentRequest(db: Queryable, input: CreateParentRequestInput): Promise<CreatedParentRequest> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  const orderId = requireUuid(input.orderId, "orderId");
  const submissionKey = requireUuid(input.submissionKey, "submissionKey");
  const characterId = input.characterId === null ? null : requireUuid(input.characterId, "characterId");
  const rows = await runQuery<CreatedRow>(db, CREATE_REQUEST, [
    parentProfileId,
    orderId,
    input.type,
    input.title,
    input.description,
    characterId,
    input.durationKey,
    input.videoScript,
    input.videoStyle,
    input.animationStyle,
    input.filePath,
    input.durationChoice,
    input.charactersSpeak,
    input.childName,
    input.originalFilename,
    submissionKey,
    input.fileMimeType,
  ]);
  return toCreated(rows[0]);
}

const SELECT_BY_SUBMISSION_KEY = `
  SELECT o.id, o.type, o.status, o.candy_cost, o.payment_source
  FROM public.orders o
  WHERE o.parent_id = $1 AND o.submission_key = $2`;

export interface RequestBySubmissionKey {
  orderId: string;
  type: string;
  status: string;
  candyCost: number;
  paymentSource: string;
}

/**
 * The caller's own order for a submission key, or null. Ownership is the
 * `parent_id = $1` predicate with the profile the caller resolved for the
 * signed-in user, so another parent's key (guessed or leaked) finds nothing
 * and is indistinguishable from a key that was never used. Returns the minimum
 * the recovery flow needs - no title, description, file path or balance.
 */
export async function findRequestBySubmissionKey(
  db: Queryable,
  input: { parentProfileId: string; submissionKey: string },
): Promise<RequestBySubmissionKey | null> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  const submissionKey = requireUuid(input.submissionKey, "submissionKey");
  const rows = await runQuery<{ id: unknown; type: unknown; status: unknown; candy_cost: unknown; payment_source: unknown }>(
    db,
    SELECT_BY_SUBMISSION_KEY,
    [parentProfileId, submissionKey],
  );
  const row = rows[0];
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.type !== "string" ||
    typeof row.status !== "string" ||
    typeof row.candy_cost !== "number" ||
    typeof row.payment_source !== "string"
  ) {
    throw new TypeError("order row has an unexpected shape");
  }
  return { orderId: row.id, type: row.type, status: row.status, candyCost: row.candy_cost, paymentSource: row.payment_source };
}

const SELECT_CHARACTER = `
  SELECT c.id
  FROM public.characters c
  WHERE c.name = $1 AND c.is_active = true`;

/**
 * Resolve the character NAME a creation form stored to the id the request
 * function validates. A value that is already a UUID is returned as is (the
 * function still checks it exists and is active). Null = no such active
 * character.
 */
export async function resolveCharacterId(db: Queryable, nameOrId: string): Promise<string | null> {
  const value = nameOrId.trim();
  if (value.length === 0 || value.length > 200) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  const rows = await runQuery<{ id: unknown }>(db, SELECT_CHARACTER, [value]);
  const id = rows[0]?.id;
  return typeof id === "string" ? id : null;
}
