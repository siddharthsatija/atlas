import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";
import { ConsentService } from "@/server/consent/consent-service";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import {
  AAD_COLUMN,
  AAD_TABLE,
  PersonalFieldRepository,
} from "@/server/repositories/personal-field-repository";

/**
 * ATL-105 — the consent gate, the encryption round trip, masking, reveal
 * auditing, deletion and the `markUsed` seam, end to end against a real database.
 *
 * Deliberately not a doubles suite. The acceptance criteria are claims about what
 * is *actually stored*: that nothing is written without consent, that what is
 * written is ciphertext, that reads are masked, and that a field is genuinely
 * hard-deletable. A fake store can satisfy all four while the real one does not.
 *
 * The cryptography is real throughout — nothing here stubs `seal` or `open` — so
 * a broken envelope fails these tests too.
 *
 * Requires a running local Supabase (`pnpm db:start`) with `.env.local` loaded,
 * because encryption needs `ATLAS_KEK` and the consent writes need
 * `AUDIT_HMAC_KEY`.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

let admin: TypedClient;
let fields: PersonalFieldService;
let consent: ConsentService;
let crypto: EncryptionService;
let repository: PersonalFieldRepository;

let consented: string;
let unconsented: string;

const EMAIL = "alex.the.person@example.com";
const PHONE = "+1 (202) 555-0134";

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `atl105-svc-${label}-${Date.now()}@example.test`,
    password: `Fixture-${label}-${Date.now()}`,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create ${label}: ${created.error?.message ?? "no user returned"}`);
  }
  return created.data.user.id;
}

beforeAll(async () => {
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-105 service tests require SUPABASE_SERVICE_ROLE_KEY, ATLAS_KEK and " +
        "AUDIT_HMAC_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  fields = PersonalFieldService.create(admin);
  consent = new ConsentService(admin);
  crypto = new EncryptionService(admin);
  repository = new PersonalFieldRepository(admin);

  consented = await createUser("consented");
  unconsented = await createUser("unconsented");

  await consent.grant(consented, "personal_fields_storage");
});

afterAll(async () => {
  if (!admin) return;
  for (const id of [consented, unconsented]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

describe("the consent gate fails closed", () => {
  it("reports storage as not permitted before any decision", async () => {
    expect(await fields.isStoragePermitted(unconsented)).toBe(false);
  });

  it("refuses to save without consent", async () => {
    const result = await fields.save(unconsented, {
      fieldKey: "email",
      label: "Personal",
      value: EMAIL,
    });

    expect(result).toEqual({ ok: false, code: "CONSENT_REQUIRED" });
  });

  it("wrote no row at all", async () => {
    /**
     * "Returned CONSENT_REQUIRED" and "wrote nothing" are different claims, and
     * only the second is the acceptance criterion.
     */
    const rows = await admin.from("user_personal_fields").select("id").eq("user_id", unconsented);

    expect(rows.data ?? []).toHaveLength(0);
  });

  it("refuses an edit without consent", async () => {
    const result = await fields.edit(unconsented, "00000000-0000-4000-8000-000000000000", {
      label: "Renamed",
    });

    /**
     * `CONSENT_REQUIRED` and not `NOT_FOUND`, even though the id does not exist:
     * the gate runs before the lookup, so a person without consent learns nothing
     * about which ids are real.
     */
    expect(result).toEqual({ ok: false, code: "CONSENT_REQUIRED" });
  });

  it("never creates a consent record as a side effect of a refused save", async () => {
    /**
     * The decision this ticket turned on: consent is a user action, not a storage
     * side effect. A service that manufactured the record would make it worthless
     * as evidence that anyone agreed.
     */
    expect(await consent.hasConsent(unconsented, "personal_fields_storage")).toBe(false);

    const rows = await admin
      .from("consents")
      .select("id")
      .eq("user_id", unconsented)
      .eq("consent_type", "personal_fields_storage");

    expect(rows.data ?? []).toHaveLength(0);
  });

  it("refuses again after consent is revoked", async () => {
    const temporary = await createUser("revoked");
    await consent.grant(temporary, "personal_fields_storage");
    await consent.revoke(temporary, "personal_fields_storage");

    const result = await fields.save(temporary, {
      fieldKey: "phone",
      label: "Mobile",
      value: PHONE,
    });

    expect(result).toEqual({ ok: false, code: "CONSENT_REQUIRED" });
    await admin.auth.admin.deleteUser(temporary);
  });
});

describe("once consent exists", () => {
  let fieldId: string;

  beforeAll(async () => {
    const saved = await fields.save(consented, {
      fieldKey: "email",
      label: "Personal Gmail",
      value: EMAIL,
    });
    if (!saved.ok) throw new Error(`save failed: ${saved.code}`);
    fieldId = saved.data.id;
  });

  it("stores the field", () => {
    expect(fieldId).toBeTruthy();
  });

  it("returns no value on the record, masked or otherwise", async () => {
    const record = await repository.find(consented, fieldId);
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(EMAIL);
    expect(Object.keys(record ?? {})).not.toContain("value_encrypted");
  });

  it("stores ciphertext, not the value", async () => {
    const stored = await admin
      .from("user_personal_fields")
      .select("value_encrypted")
      .eq("id", fieldId)
      .single();

    expect(stored.error).toBeNull();
    expect(stored.data?.value_encrypted).not.toContain(EMAIL);
    expect(stored.data?.value_encrypted).not.toContain("alex.the.person");
  });

  it("round-trips the value unchanged on reveal", async () => {
    const revealed = await fields.reveal(consented, fieldId);
    expect(revealed).toEqual({ ok: true, data: EMAIL });
  });

  it("masks the value in the default list read", async () => {
    const listed = await fields.listMasked(consented);
    if (!listed.ok) throw new Error(`list failed: ${listed.code}`);

    const entry = listed.data.find((field) => field.id === fieldId);
    expect(entry).toBeDefined();
    expect(entry?.maskedValue).not.toBe(EMAIL);
    /** Recognisable without being disclosive — ATL-035's masking contract. */
    expect(entry?.maskedValue).toContain("@example.com");
    expect(entry?.maskedValue).toContain("•");
    expect(entry?.label).toBe("Personal Gmail");
  });

  it("binds each ciphertext to its own row", async () => {
    /**
     * ADR-003's AAD is `table.column:record_id`. Ciphertext lifted from one field
     * cannot be decrypted as another, so a database operator cannot swap values
     * between rows undetected.
     */
    const other = await fields.save(consented, {
      fieldKey: "phone",
      label: "Mobile",
      value: PHONE,
    });
    if (!other.ok) throw new Error("second save failed");

    const stored = await admin
      .from("user_personal_fields")
      .select("value_encrypted")
      .eq("id", fieldId)
      .single();

    await expect(
      crypto.decrypt(consented, stored.data?.value_encrypted ?? "", {
        table: AAD_TABLE,
        column: AAD_COLUMN,
        recordId: other.data.id,
      }),
    ).rejects.toThrow();
  });

  it("re-encrypts against the same AAD on edit", async () => {
    const edited = await fields.edit(consented, fieldId, { value: "alex.new@example.com" });
    expect(edited.ok).toBe(true);

    const revealed = await fields.reveal(consented, fieldId);
    expect(revealed).toEqual({ ok: true, data: "alex.new@example.com" });
  });

  it("rejects an empty value rather than storing one", async () => {
    const result = await fields.save(consented, {
      fieldKey: "other",
      label: "Blank",
      value: "   ",
    });
    expect(result).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("reveal is audited", () => {
  it("records personal_field.revealed without the value", async () => {
    const saved = await fields.save(consented, {
      fieldKey: "username",
      label: "Handle",
      value: "alex-handle-1234",
    });
    if (!saved.ok) throw new Error("save failed");

    await fields.reveal(consented, saved.data.id);

    const events = await admin
      .from("audit_events")
      .select("event_type, entity_type, context_json")
      .eq("event_type", "personal_field.revealed")
      .order("occurred_at", { ascending: false })
      .limit(5);

    expect(events.error).toBeNull();
    expect((events.data ?? []).length).toBeGreaterThan(0);

    const serialised = JSON.stringify(events.data);
    expect(serialised).not.toContain("alex-handle-1234");
    expect(serialised).not.toContain(EMAIL);
  });
});

describe("cross-user access", () => {
  it("answers NOT_FOUND for another person's field", async () => {
    const saved = await fields.save(consented, {
      fieldKey: "address",
      label: "Home",
      value: "1 Example Street",
    });
    if (!saved.ok) throw new Error("save failed");

    await consent.grant(unconsented, "personal_fields_storage");
    const stolen = await fields.reveal(unconsented, saved.data.id);

    /** Indistinguishable from "no such field", so a guessed id is not an oracle. */
    expect(stolen).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("deletion", () => {
  it("hard-deletes one field and leaves the rest", async () => {
    const doomed = await fields.save(consented, {
      fieldKey: "other",
      label: "Temporary",
      value: "delete-me",
    });
    if (!doomed.ok) throw new Error("save failed");

    const before = await fields.listMasked(consented);
    if (!before.ok) throw new Error("list failed");

    const removed = await fields.remove(consented, doomed.data.id);
    expect(removed).toEqual({ ok: true, data: { id: doomed.data.id } });

    const rows = await admin.from("user_personal_fields").select("id").eq("id", doomed.data.id);
    expect(rows.data ?? []).toHaveLength(0);

    const after = await fields.listMasked(consented);
    if (!after.ok) throw new Error("list failed");
    expect(after.data.length).toBe(before.data.length - 1);
  });

  it("reports NOT_FOUND rather than success for an absent field", async () => {
    const result = await fields.remove(consented, "00000000-0000-4000-8000-000000000000");
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("stays available after consent is revoked", async () => {
    /**
     * Deletion is the safe direction. Gating it would mean a person who revoked
     * consent could no longer remove the values the revocation was about.
     */
    const temporary = await createUser("delete-after-revoke");
    await consent.grant(temporary, "personal_fields_storage");
    const saved = await fields.save(temporary, {
      fieldKey: "phone",
      label: "Mobile",
      value: PHONE,
    });
    if (!saved.ok) throw new Error("save failed");

    await consent.revoke(temporary, "personal_fields_storage");

    expect(await fields.remove(temporary, saved.data.id)).toEqual({
      ok: true,
      data: { id: saved.data.id },
    });

    await admin.auth.admin.deleteUser(temporary);
  });
});

describe("the markUsed seam (ATL-058's first caller)", () => {
  it("stamps last_used_at on the fields a draft included", async () => {
    const saved = await fields.save(consented, {
      fieldKey: "full_name",
      label: "Legal name",
      value: "Alex Person",
    });
    if (!saved.ok) throw new Error("save failed");
    expect(saved.data.lastUsedAt).toBeNull();

    const stamped = await fields.markUsed(consented, [saved.data.id]);
    expect(stamped).toEqual({ ok: true, data: 1 });

    const record = await repository.find(consented, saved.data.id);
    expect(record?.lastUsedAt).not.toBeNull();
  });

  it("stamps nothing for another person's field", async () => {
    const saved = await fields.save(consented, {
      fieldKey: "other",
      label: "Scoped",
      value: "scoped-value",
    });
    if (!saved.ok) throw new Error("save failed");

    expect(await fields.markUsed(unconsented, [saved.data.id])).toEqual({ ok: true, data: 0 });

    const record = await repository.find(consented, saved.data.id);
    expect(record?.lastUsedAt).toBeNull();
  });

  it("is a no-op for an empty key list", async () => {
    expect(await fields.markUsed(consented, [])).toEqual({ ok: true, data: 0 });
  });
});
