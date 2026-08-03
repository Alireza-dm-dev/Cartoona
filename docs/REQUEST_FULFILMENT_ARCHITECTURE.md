# Request Fulfilment Architecture

Admin-driven fulfilment of parent requests: controlled status transitions,
append-only activity history, private final-media delivery, and a strict parent
visibility boundary. Implementation: `supabase/migrations/20260801120000_request_fulfilment_workflow.sql`
(DB) + `lib/admin/requests/*` (app) + `components/admin/requests/*` (UI).

## Principles

- **No new order status values.** The existing 8 statuses suffice. See
  `lib/admin/requests/workflow.ts` (`REQUEST_STATUS_DEFINITIONS`) — the single
  TS source of truth for labels, transitions, and rules, mirrored in SQL.
- **All order/status/media mutations go through service-role-only trusted RPCs.**
  Browser roles get SELECT-only grants (existing) plus nothing new.
- **Append-only history.** `order_status_history` cannot be updated or deleted
  directly (BEFORE trigger raises). Data flows through SECURITY DEFINER reads.
- **Internal notes are never readable by parents.**
- **Final media is private until explicitly approved** (`parent_visible=true`).
- **No financial mutation.** No candy/wallet/ledger changes; no automatic
  refunds. Refund policy for rejected/cancelled is deferred (documented in the
  status definitions).

## Status model & transitions

Only these transitions are allowed (enforced in both TS and SQL):

```
pending_review → in_progress → ready → delivered
pending_review/in_progress → rejected | cancelled   (terminal)
```

Rules:

- `ready` requires ≥ 1 approved, parent-visible final asset.
- `rejected` requires a reason (internal or parent-visible note).
- No-op and unknown target statuses are rejected.
- Terminal statuses (`delivered`/`rejected`/`cancelled`) never reopen.
- `draft`/`pending_payment` are pre-submission states with no workflow.

Persian labels: `app` uses `mapOrderStatusLabel` from `workflow.ts`.

## Schema additions

### `order_status_history` (append-only)

- Columns: `id`, `order_id` (FK cascade), `previous_status`, `new_status`,
  `changed_by_user_id` (FK SET NULL), `internal_note`, `parent_visible_note`,
  `created_at`.
- Status + note-length CHECKs; index on `(order_id, created_at DESC)`.
- RLS enabled, no grants to `anon`/`authenticated`.
- Append-only trigger blocks direct UPDATE/DELETE (except FK cascades) and
  TRUNCATE.

### `media_assets` extension

- `asset_role`: `source | final | preview | supporting` (default `source`).
- `delivery_status`: `uploaded | approved | superseded` (final/preview only).
- `parent_visible` (default false), `uploaded_by_user_id`,
  `original_filename`, `byte_size`, `superseded_at`, `updated_at` (+ trigger).
- Invariant CHECKs: final/preview are `type='generated'`; superseded ⇒ hidden +
  `superseded_at`; non-negative `byte_size`; filename ≤ 255.

### Parent visibility boundary

The parent `media_assets` SELECT policy now returns **only** `source` assets or
`final` assets that are `approved` + `parent_visible`. Unapproved and superseded
finals are invisible to parents.

### Storage: `final-deliverables` (private)

- Bucket: private, 100 MiB limit, MIME whitelist
  (png/jpeg/webp + mp4/webm).
- Path strategy: `orders/<order-id>/final/<uuid>.<ext>`.
- Admin CRUD policies; parent SELECT only via the SECURITY DEFINER helper
  `is_parent_approved_final_deliverable(path)` which verifies the row is an
  approved, parent-visible final of the parent's own order.
- Signed URLs are generated on demand (TTL 300 s) and never persisted.

## Trusted RPCs (service_role only)

| Function | Purpose |
| --- | --- |
| `update_order_status_trusted` | Locks order, verifies `expectedUpdatedAt` (optimistic concurrency), validates transition, enforces ready/rejected rules, updates order + appends history atomically. |
| `record_final_media_trusted` | Registers an uploaded final asset (`uploaded`, not visible). Re-checks admin role, order status allows upload, path prefix/traversal, storage object existence + MIME match. |
| `approve_final_media_trusted` | `uploaded → approved` + `parent_visible=true`. |
| `supersede_final_media_trusted` | `uploaded/approved → superseded`, hidden, `superseded_at` stamped. No delete. |

Read functions (authenticated):
`get_order_status_history_admin` (admin only; internal notes + admin email) and
`get_parent_order_status_history` (own order; status + parent-visible note only).

## Controlled error codes

RPCs `RAISE EXCEPTION '<code>'`. The app maps them to HTTP + Persian messages in
`lib/admin/requests/fulfilment-errors.ts`:

- 403: `request_admin_forbidden`, `request_forbidden`
- 404: `request_not_found`, `request_asset_not_found`
- 409: `request_status_conflict`, `request_status_unchanged`, `request_upload_not_allowed`,
  `request_asset_not_uploaded`, `request_asset_already_superseded`
- 422: `request_transition_invalid`, `request_invalid_status`,
  `request_final_media_required`, `request_rejection_reason_required`,
  `request_note_too_long`, `request_file_invalid`
- 400/500 fallbacks for malformed/unknown errors. Raw DB strings are never
  exposed; the client only ever sees `REQUEST_*` codes.

## API routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/admin/requests/[requestId]/status` | PATCH | Controlled transition (JSON: `status`, `expectedUpdatedAt`, notes). Body ≤ 8 KiB. |
| `/api/admin/requests/[requestId]/final-media` | POST | Multipart upload (≤ 5 files). Upload → DB insert; on DB failure the object is deleted (rollback). |
| `/api/admin/requests/[requestId]/final-media/[assetId]` | PATCH | `{ action: "approve" \| "supersede" }`. |

All routes: `force-dynamic` + `nodejs` runtime, admin-auth via
`requireAdminFulfilmentAuth` (throws 401/403/500 safely).

## Upload flow

1. Client validates MIME + size (fail fast; server/DB re-check).
2. Server uploads to `final-deliverables` at `orders/<orderId>/final/<uuid>.<ext>`.
3. `record_final_media_trusted` verifies order status, path safety, storage
   object + MIME, then inserts `uploaded`/not-visible.
4. Admin previews (short signed URL), then **approves** → parent-visible.
5. `ready` unlocks once ≥ 1 approved final exists. Supersede hides a version
   permanently (no delete; history preserved).

## Tests

- Unit (`tests/unit/`): `request-workflow.test.ts`, `final-media-validation.test.ts`,
  `fulfilment-types.test.ts`, `fulfilment-errors.test.ts` — pure, no DB.
- e2e (`tests/e2e/`): `admin-request-fulfilment-db.spec.ts` (guarded stateful
  RPC/API flow) and `admin-request-fulfilment-ui.spec.ts` (guarded UI) — require
  a disposable/local target + running dev server; refused on main projects.

## Out of scope (this migration)

- No candy refunds, no wallet/ledger changes.
- No API for parent-initiated actions (future parent tracking page reuses
  `get_parent_order_status_history` + `toParentFinalAssetInfo`).
- No deletion of final media (supersede only).
- No email/notification automation.
