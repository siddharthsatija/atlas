-- ATL-104 · idempotency_keys
--
-- Backing store for idempotent transitions and jobs. Architecture §7.17 and
-- §14, security §retention (24 hours).
--
-- APPEND-ONLY: this migration adds a table and touches nothing that came before.
-- The profiles, user_encryption_keys, and audit_events migrations and their
-- policies are untouched.
--
-- rls: deny-all
--
-- No client policies. The table carries a `user_id`, but it is infrastructure
-- rather than user-facing data: no product surface reads it, and a client that
-- could read or write it could observe or forge the replay behaviour of another
-- request. Only server-side service-role modules touch it (security §7).
create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  -- Owner. Scoping keys per user means one user's key choice can never collide
  -- with, or reveal anything about, another's.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Which operation family the key belongs to, e.g. `request_transition`,
  -- `export_job` (architecture §7.17). Two different operations may legitimately
  -- use the same client-supplied key, so scope is part of the identity.
  scope text not null check (scope ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- The caller-supplied key. Opaque; never parsed.
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 255),
  -- The recorded result, encrypted under the ADR-003 envelope scheme.
  --
  -- Architecture §7.17 originally listed only `result_hash`. A hash can verify a
  -- result but cannot return one, so it could not satisfy the ATL-104 criterion
  -- that a duplicate submission "returns the recorded result". The payload is
  -- therefore stored, and stored encrypted: a transition result can name
  -- entities and statuses, and this table would otherwise become a second,
  -- lower-scrutiny copy of that data with its own lifetime.
  --
  -- NULL is meaningful. It marks a **claimed but not yet completed** operation,
  -- which is what makes the double-submit race detectable without a separate
  -- status column: the row is inserted before the handler runs, so a concurrent
  -- caller finds the claim and knows to wait rather than execute.
  result_encrypted text check (
    result_encrypted is null
    or (char_length(result_encrypted) between 1 and 8192)
  ),
  -- SHA-256 of the canonical plaintext result.
  --
  -- Kept alongside the ciphertext deliberately. AES-256-GCM already detects
  -- tampering with the ciphertext, but this detects a different failure: a
  -- result that decrypts cleanly yet is not what was originally recorded —
  -- a row swapped wholesale from another operation, or a serialisation change
  -- between deploys. Set together with the ciphertext, so both are null while
  -- the claim is in flight.
  result_hash text check (
    result_hash is null
    or result_hash ~ '^[0-9a-f]{64}$'
  ),
  -- Purged after 24 hours (security §retention, architecture §14).
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  -- A completed record is all-or-nothing.
  --
  -- Without this, a row could carry a ciphertext with no hash to check it
  -- against, or a completion timestamp with no result — states in which the
  -- replay path would have to guess. Guessing here means either re-executing an
  -- operation that already ran or returning something that was never recorded.
  constraint idempotency_keys_completion_is_complete check (
    (
      result_encrypted is not null
      and result_hash is not null
      and completed_at is not null
    )
    or (
      result_encrypted is null
      and result_hash is null
      and completed_at is null
    )
  )
);

comment on table public.idempotency_keys is 'Idempotency claims for transitions and jobs (architecture §7.17). Service-role only; results encrypted per ADR-003. Purged after 24 hours.';

comment on column public.idempotency_keys.result_encrypted is 'Envelope-encrypted result (ADR-003). NULL means the operation is claimed but still in flight.';

comment on column public.idempotency_keys.result_hash is 'SHA-256 of the canonical plaintext result, verified after decryption.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The identity of a key, and the mechanism that makes the claim atomic.
--
-- Two simultaneous submissions both find no row and both try to insert; this
-- index lets exactly one win. The loser receives a unique violation, which is
-- the signal that another caller is already handling the operation — so the
-- race resolves in the database rather than in application logic that would
-- have to be right on every path.
create unique index idempotency_keys_scope_key_unique on public.idempotency_keys (user_id, scope, idempotency_key);

-- The purge job scans by expiry.
create index idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- Foreign-key support (CLAUDE.md database rules — index foreign keys).
create index idempotency_keys_user_id_idx on public.idempotency_keys (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — deny all
-- ---------------------------------------------------------------------------
--
-- RLS on, no policies created: every client role is denied every row. There is
-- no predicate to get wrong because there is no predicate (security §7).
alter table public.idempotency_keys enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The grant gate is the primary control. `anon` and `authenticated` are revoked
-- explicitly so a policy added later by mistake still grants nothing.
revoke all on public.idempotency_keys
from
  anon;

revoke all on public.idempotency_keys
from
  authenticated;

-- `service_role` gets what the claim lifecycle needs:
--   select — find an existing claim on replay
--   insert — stake the claim
--   update — record the result once the handler returns
--   delete — release a claim whose handler failed, and purge expired keys
--
-- DELETE is granted here, unlike `audit_events` where it is withheld entirely.
-- The difference is what the rows mean: an audit event is evidence, and erasing
-- it destroys the record of what happened. An idempotency key is a 24-hour
-- lock. Removing one costs at most a duplicate execution of an operation that
-- is, by construction, safe to repeat once the window has passed.
grant
select
,
  insert,
update,
delete on public.idempotency_keys to service_role;
