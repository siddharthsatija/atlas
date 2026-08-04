# Security remediation runbook

Operational procedures for ATL-090. The authority for what must be true is
`docs/03-security-and-access.md` §9 (secret management) and §20 (incident
response), plus ADR-003 (KEK/DEK rotation) and ADR-006 (audit HMAC key). This
document explains **what to do when a scan fires** — it does not restate policy.

## Reporting a vulnerability

Do not open a public issue. Contact the security owner directly. Suspected exposure
of restricted data (security §3) triggers incident response immediately — do not
wait for review (`security-engineer` escalation rules).

---

## 1. A secret was detected

Automated scanning runs on every pull request:

| Scan                | What it covers                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm scan:secrets` | First-party rules including Atlas-specific credentials (`ATLAS_KEK`, `AUDIT_HMAC_KEY`, Supabase service-role JWTs) |
| `gitleaks`          | Full git history, generic credential patterns                                                                      |

Both block the merge.

### If the value is a real credential

**Treat detection as compromise.** A secret in a branch, a PR, or CI logs must be
assumed to have leaked (security §9: _rotate any exposed credential immediately_).

1. **Contain.** Do not force-push to "remove" it first — rotation comes first, because
   history rewriting does not invalidate a key that was already read.
2. **Rotate immediately**, using the procedure for that credential:

   | Credential                | Rotation                                                                                                                                                                |
   | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Supabase service-role key | Regenerate in the Supabase dashboard for that project only; update the environment's secret store                                                                       |
   | Supabase anon key         | Regenerate; it is RLS-constrained but still identifies the project                                                                                                      |
   | `ATLAS_KEK`               | Generate a new KEK and **re-wrap every DEK** — metadata only, no row re-encryption (ADR-003). Bump `ATLAS_KEK_VERSION`                                                  |
   | `AUDIT_HMAC_KEY`          | Generate a new key. Note: `subject_ref` values computed under the old key no longer correlate; record the rotation point so audit continuity is interpretable (ADR-006) |
   | `ANTHROPIC_API_KEY`       | Revoke and reissue in the provider console                                                                                                                              |
   | Rate-limit store token    | Regenerate in the provider console                                                                                                                                      |

3. **Invalidate the old value.** Rotation is incomplete until the previous credential
   is revoked, not merely replaced.
4. **Assess blast radius.** Which environment? Which data could that credential
   reach? A production service-role key is a Critical incident (security §20); a
   local placeholder is not an incident at all.
5. **Revoke sessions** if user authentication could be affected.
6. **Record the exposure** — what leaked, when, which environment, when it was
   rotated, and who confirmed revocation. The deployment skill requires exposures to
   be documented, not just fixed.
7. **Purge the value from history** only after rotation, if it is warranted.
8. **Notify** according to legal and contractual obligations (security §20 step 6).
9. **Post-incident review**: why did it reach a branch, and which control should have
   caught it earlier?

### If the value is a false positive

The scanner deliberately ignores obvious placeholders. If a legitimate value still
trips it, suppress it **narrowly and visibly**:

```ts
// atlas-scan-ignore — documented test fixture, not a credential
const example = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fixture.signature";
```

The marker applies to that line and the one following it. A suppression without a
reason is not acceptable — it is the same as disabling the scanner.

Never suppress by widening `EXCLUDED_PATHS` in `scripts/lib/secret-scan.ts` for
convenience; that silently blinds the scanner to an entire file.

---

## 2. A dependency advisory was detected

`pnpm deps:verify` runs on every pull request. **High and critical advisories block
the merge.**

### Remediation order

1. **Upgrade the direct dependency** if it is ours and a patched version exists.
2. **Override a transitive dependency** via `pnpm.overrides` when the parent pins a
   vulnerable version — then **verify the whole suite**, because an override forces a
   version the parent never tested against.

   **Scope the override to the major the parent already depends on.** pnpm override
   keys accept a range selector (`"pkg@^1.0.0": "1.1.18"`), so a tree containing two
   majors of the same package gets each one patched inside its own line, and no
   parent is handed an API it was never written against.

   Both precedents are `brace-expansion`, and the difference between them is the
   whole rule:
   - ❌ A bare `"brace-expansion": "<patched major>"` forced 2.x onto `minimatch@3`,
     which needs the 1.x `expand` export. `pnpm lint` crashed with
     "TypeError: expand is not a function". Reverted as an unsafe forced upgrade.
   - ✅ `"brace-expansion@^1.0.0": "1.1.18"` + `"brace-expansion@^5.0.0": "5.0.9"`
     (GHSA-rgw5-rvv9-x895) patched both copies within their existing majors. Both
     versions already satisfied the parents' declared ranges (`minimatch@3` wants
     `^1.1.7`, `minimatch@10` wants `^5.0.8`), so nothing was forced at all.

   If the patched version falls inside the parent's declared range, the override is
   not a forced upgrade — it is pinning a version the parent already permits, and it
   is the preferred outcome.

3. **Replace the dependency** if it is unmaintained.
4. **Accept the risk temporarily** — only when remediation is genuinely unavailable
   or breaking. This requires a time-boxed exception (below).

Never apply an unsafe forced upgrade to make the gate green.

### Adding a time-boxed exception

Add an entry to `.github/dependency-exceptions.json`:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "reason": "Why remediation is unavailable, and why the residual risk is acceptable — including exposure (dev-only? runtime? client?) and what an attacker would need.",
  "acceptedBy": "security-engineer",
  "expires": "2026-10-31",
  "tracking": "ATL-000"
}
```

Rules enforced by the gate:

- **Every field is required.** An exception without a reason, owner, expiry, or
  tracking reference is an omission, not a decision.
- **Expiry is enforced.** After `expires`, the build fails until the risk is
  re-decided. Exceptions do not become permanent by neglect.
- **Stale exceptions fail too.** If the advisory no longer appears, the entry must be
  removed, so a future recurrence is not silently pre-accepted.
- Maximum recommended window: **90 days**.

This replaced pnpm's `auditConfig.ignoreGhsas`, which hid an advisory so completely
that `pnpm audit --json` reported zero findings — an accepted risk with no expiry,
no owner, and no review trigger.

---

## 3. Key rotation outside an incident

Rotation is also a routine, rehearsed procedure — it must not be first attempted
during an incident (deployment skill; security §21 launch checklist).

| Key              | Cadence                                       | Procedure                                                                                |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ATLAS_KEK`      | Rehearsed before launch; rotated on suspicion | New KEK → re-wrap all DEKs → bump `ATLAS_KEK_VERSION`. Data rows are untouched (ADR-003) |
| Per-user DEK     | On suspected compromise of one user           | Idempotent, resumable background job re-encrypts that user's rows (ADR-003)              |
| `AUDIT_HMAC_KEY` | On suspicion only                             | Rotating changes `subject_ref` derivation; record the rotation point (ADR-006)           |
| Provider keys    | On exposure or personnel change               | Provider console; update the environment's secret store only                             |

After any rotation, run `pnpm env:check:staging` / `pnpm env:check:production` to
confirm the environment is still coherent and isolated (ATL-003).

---

## 4. Verifying the gates still work

A gate that cannot fail provides no protection. Both scans have deliberate-defect
fixtures:

```bash
pnpm gates:verify --only secrets,dependencies
```

This writes a fixture containing a synthetic credential and a fixture advisory,
confirms each gate exits non-zero, and removes them. Run it after changing scanner
rules or dependency policy.
