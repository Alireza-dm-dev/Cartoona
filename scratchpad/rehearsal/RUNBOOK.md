# Migration Rehearsal Runbook — Request Submission RPC Chain

Covers the `create_parent_request_trusted` overload chain across the five
migrations that touch it in production cutover order.

## Cutover order

```
20260915100000_creation_form_cleanup.sql
20260918100000_order_child_name.sql
20260918110000_optional_parent_full_name.sql
20260918120000_request_source_original_filename.sql
20260918130000_seed_canonical_characters.sql
```

`20260918110000` and `20260918130000` do not touch
`create_parent_request_trusted` and are not part of the RPC-hardening review;
they are listed here only to preserve the full cutover order.

## Signature owners

Each RPC-changing migration owns exactly one signature and rewinds the
function to that signature before recreating it:

| Migration | Owns signature |
|---|---|
| `20260915100000_creation_form_cleanup.sql` | 13-arg |
| `20260918100000_order_child_name.sql` | 14-arg |
| `20260918120000_request_source_original_filename.sql` | 15-arg |

At the end of the full chain, exactly **one** 15-argument overload of
`create_parent_request_trusted` exists in `public`. No other overload
survives.

## How the hardening works

Each of the three RPC-changing migrations now drops every signature the
function has ever legitimately had — by exact, explicit argument list — before
`CREATE OR REPLACE FUNCTION` recreates its own:

```
DROP FUNCTION IF EXISTS public.create_parent_request_trusted(...)  -- 11-arg
DROP FUNCTION IF EXISTS public.create_parent_request_trusted(...)  -- 13-arg
DROP FUNCTION IF EXISTS public.create_parent_request_trusted(...)  -- 14-arg
DROP FUNCTION IF EXISTS public.create_parent_request_trusted(...)  -- 15-arg
CREATE OR REPLACE FUNCTION public.create_parent_request_trusted(...)
```

`DROP FUNCTION IF EXISTS` on a signature that doesn't yet exist is a no-op, so
running an earlier migration's file again after a later one has already run
is safe: it rewinds the function to the signature that migration owns, and
does not silently leave a stray overload behind.

`COMMENT ON FUNCTION` is signature-qualified in every RPC-changing migration
(`COMMENT ON FUNCTION public.create_parent_request_trusted(<exact arg list>)
IS ...`), so it always targets the one overload that migration owns instead
of being ambiguous once more than one overload exists.

No `CASCADE` is used on any of the drops. Permissions (`GRANT EXECUTE ... TO
service_role`) are unchanged by this hardening.

## Stop / recovery procedure

### Old assumption (no longer applies)

Previously: a duplicate-overload condition (PGRST203, "Could not choose the
best candidate function") had to be detected by watching PostgREST error
output during rollout, and manually avoided by never re-running an
RPC-changing migration once a later one had applied.

### New behavior

- Re-running any RPC-changing migration is now safe at any point in the
  chain, whether run standalone or as part of a full re-run.
- Re-running one of `20260915100000`, `20260918100000`, or `20260918120000`
  rewinds `create_parent_request_trusted` to exactly the signature that
  migration owns (13-, 14-, or 15-arg respectively) — no matter what overload
  state existed beforehand — because it explicitly drops all four known
  historical signatures first.
- If a migration run is interrupted (mid-chain failure, connection drop,
  etc.), recovery is to **continue forward from the failed migration**, not
  to restart the whole chain. Since every RPC-changing migration is now
  idempotent with respect to the function's overload state, resuming forward
  is always safe.
- The full 5-migration chain can also be safely re-run end-to-end from
  `20260915100000` if that is operationally simpler — idempotency holds
  either way — but it is not required.
- **Preferred operational procedure:** resume from the failed migration
  rather than restart the chain unnecessarily. A full restart is a fallback,
  not the default.
- At the final state of the chain (after `20260918130000`), exactly one
  15-argument overload of `create_parent_request_trusted` exists, and no
  PGRST203 ambiguity remains for any caller.

### Stop conditions

Halt the rollout and do not proceed to the next migration if any of the
following occur:

- **Unexpected schema mismatch** — a column, type, or constraint on
  `orders`, `video_requests`, or `media_assets` does not match what the
  migration expects.
- **Migration SQL error** — the migration fails to apply cleanly (syntax
  error, missing dependency, permission error on the Postgres role running
  the migration).
- **Unexpected row-count change** — an `INSERT`/`UPDATE` inside the RPC or
  migration affects more or fewer rows than expected for a given test call.
- **RPC ambiguity** — PostgREST returns PGRST203 (or any "could not choose
  the best candidate function" error) for a call to
  `create_parent_request_trusted`.
- **Incorrect ACL** — `GRANT`/`REVOKE` state on the function or affected
  tables does not match the expected `service_role`-only access after the
  migration applies.
- **Character seed mismatch** — the canonical character seed data
  (`20260918130000_seed_canonical_characters.sql`) does not match the
  expected canonical set after applying.

## Scope note

This rehearsal and hardening review covers only the RPC-signature handling
in the three migrations listed under "Signature owners" above. It does not
re-validate the full disposable end-to-end rehearsal beyond that scope; a
full re-rehearsal is only required if the migration SQL changes further
beyond the hardening already reviewed here.

MAIN was never mutated by this review; all verification was performed
against a disposable target, never production.
