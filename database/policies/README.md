# RLS policies

Use `rls-policy.template.sql`. Policies ship in the **same migration** as the table
they protect.

## Policy review checklist

Required by `docs/03-security-and-access.md` §7 — migration review includes policy review.

- [ ] RLS enabled on the table
- [ ] All four policies present (select, insert, update, delete), or deliberate
      deny-all for an internal table
- [ ] Policy predicate is `auth.uid() = user_id` (or `= id` for `profiles`)
- [ ] `with check` present on insert and update, not just `using`
- [ ] Child table carries `user_id` even when ownership is inferable via the parent
- [ ] Composite FK prevents referencing another user's parent row
- [ ] Two-user tests written for all four operations
- [ ] Table added to the RLS completeness list so CI fails if tests are missing
- [ ] No policy grants access based on a client-supplied value
- [ ] Service-role usage confined to server-only modules

## Deny by default

A table with RLS enabled and no matching policy denies access. That is the intended
posture for `audit_events` and `user_encryption_keys`.
