import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";
import { EncryptionService } from "@/server/crypto/encryption-service";
import {
  DataRequestRepository,
  ExternalReferenceTooLongError,
  UnknownPersonalFieldKeyError,
  AAD_BODY,
  AAD_RECIPIENT,
  AAD_STATUS_NOTE,
  AAD_SUBJECT,
  AAD_TABLE,
} from "@/server/repositories/data-request-repository";
import {
  IncompleteTransitionError,
  RequestEventRepository,
  UnknownRequestEventTypeError,
} from "@/server/repositories/request-event-repository";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import type { RequestEventType } from "@/lib/requests/request-events";

/**
 * ATL-056 — the encryption round trip and the two repositories, against a real
 * database with real cryptography.
 *
 * Deliberately not a doubles suite. The acceptance criteria are claims about
 * what is *actually stored*: that the recipient, subject, body and status note
 * are ciphertext, that each is bound to its own column so one cannot be moved
 * into another, and that `included_fields_json` holds keys and never values. A
 * fake store can satisfy all four while the real one does not.
 *
 * Nothing here stubs `seal` or `open`, so a broken envelope fails these tests
 * too.
 *
 * Requires a running local Supabase (`pnpm db:start`) with `.env.local` loaded,
 * because encryption needs `ATLAS_KEK`.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

let admin: TypedClient;
let requests: DataRequestRepository;
let events: RequestEventRepository;
let crypto: EncryptionService;

let userId: string;
let otherUserId: string;
let assetId: string;

const RECIPIENT = "privacy@acme.example";
const SUBJECT = "Deletion request for account alex.person@example.com";
const BODY = "Please delete the personal data you hold for me, including alex.person@example.com.";
const STATUS_NOTE = "Agent Dana replied: case ACME-4417 opened, reference alex.person@example.com.";

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `atl056-repo-${label}-${Date.now()}@example.test`,
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
      "ATL-056 repository tests require SUPABASE_SERVICE_ROLE_KEY and ATLAS_KEK. " +
        "Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  requests = new DataRequestRepository(admin);
  events = new RequestEventRepository(admin);
  crypto = new EncryptionService(admin);

  userId = await createUser("owner");
  otherUserId = await createUser("other");

  const asset = await admin
    .from("digital_assets")
    .insert({ user_id: userId, service_name: "Acme Media", category: "social" })
    .select("id")
    .single();

  if (asset.error || !asset.data) throw new Error("Could not seed the asset fixture");
  assetId = asset.data.id;
});

afterAll(async () => {
  if (!admin) return;
  for (const id of [userId, otherUserId]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

describe("the encryption round trip", () => {
  it("stores all four restricted values as ciphertext", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      recipient: RECIPIENT,
      subject: SUBJECT,
      body: BODY,
    });

    await requests.update(userId, created.id, { lastStatusNote: STATUS_NOTE });

    /**
     * Read through raw SQL rather than the repository, because the claim is
     * about what is *in the column* — a repository that decrypted on read would
     * make a plaintext column indistinguishable from an encrypted one.
     */
    const stored = await admin
      .from("data_requests")
      .select("recipient_encrypted, subject_encrypted, body_encrypted, last_status_note")
      .eq("id", created.id)
      .single();

    const row = stored.data;
    expect(row).not.toBeNull();
    expect(row?.recipient_encrypted).not.toContain("privacy@acme.example");
    expect(row?.subject_encrypted).not.toContain("alex.person@example.com");
    expect(row?.body_encrypted).not.toContain("delete the personal data");
    /** The fourth column, encrypted despite its name (D2). */
    expect(row?.last_status_note).not.toContain("ACME-4417");
    expect(row?.last_status_note).not.toContain("alex.person@example.com");
  });

  it("returns all four values through readContent", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "correction",
      recipient: RECIPIENT,
      subject: SUBJECT,
      body: BODY,
    });
    await requests.update(userId, created.id, { lastStatusNote: STATUS_NOTE });

    const content = await requests.readContent(userId, created.id);

    expect(content).toEqual({
      recipient: RECIPIENT,
      subject: SUBJECT,
      body: BODY,
      lastStatusNote: STATUS_NOTE,
    });
  });

  it("binds each column's ciphertext to that column", async () => {
    /**
     * The AAD claim, and the one that a single shared AAD would silently break.
     * A recipient envelope opened as a body must fail: without per-column
     * binding, a bug or a direct database edit could move the draft body into
     * the recipient field and it would decrypt cleanly.
     */
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      recipient: RECIPIENT,
    });

    const stored = await admin
      .from("data_requests")
      .select("recipient_encrypted")
      .eq("id", created.id)
      .single();

    const envelope = stored.data?.recipient_encrypted ?? "";

    await expect(
      crypto.decrypt(userId, envelope, {
        table: AAD_TABLE,
        column: AAD_BODY,
        recordId: created.id,
      }),
    ).rejects.toThrow();

    /** And it opens correctly under its own column. */
    await expect(
      crypto.decrypt(userId, envelope, {
        table: AAD_TABLE,
        column: AAD_RECIPIENT,
        recordId: created.id,
      }),
    ).resolves.toBe(RECIPIENT);
  });

  it("binds ciphertext to its row", async () => {
    const first = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      subject: SUBJECT,
    });
    const second = await requests.create({ userId, assetId, requestType: "deletion" });

    const stored = await admin
      .from("data_requests")
      .select("subject_encrypted")
      .eq("id", first.id)
      .single();

    // Moving a subject to another request must not decrypt.
    await expect(
      crypto.decrypt(userId, stored.data?.subject_encrypted ?? "", {
        table: AAD_TABLE,
        column: AAD_SUBJECT,
        recordId: second.id,
      }),
    ).rejects.toThrow();
  });

  it("cannot be read with another person's key", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      body: BODY,
    });

    const stored = await admin
      .from("data_requests")
      .select("body_encrypted")
      .eq("id", created.id)
      .single();

    await expect(
      crypto.decrypt(otherUserId, stored.data?.body_encrypted ?? "", {
        table: AAD_TABLE,
        column: AAD_BODY,
        recordId: created.id,
      }),
    ).rejects.toThrow();
  });

  it("re-encrypts an edited value against the same AAD", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      body: "First draft.",
    });

    await requests.update(userId, created.id, { body: "Second draft." });

    const content = await requests.readContent(userId, created.id);
    expect(content?.body).toBe("Second draft.");
  });

  it("leaves the status note sealed under its own column", async () => {
    const created = await requests.create({ userId, assetId, requestType: "deletion" });
    await requests.update(userId, created.id, { lastStatusNote: STATUS_NOTE });

    const stored = await admin
      .from("data_requests")
      .select("last_status_note")
      .eq("id", created.id)
      .single();

    await expect(
      crypto.decrypt(userId, stored.data?.last_status_note ?? "", {
        table: AAD_TABLE,
        column: AAD_STATUS_NOTE,
        recordId: created.id,
      }),
    ).resolves.toBe(STATUS_NOTE);
  });
});

describe("the record carries no restricted value", () => {
  it("reports presence without exposing content", async () => {
    /**
     * A surface has to know whether a draft is complete — frontend §10's Step 3
     * enables "Mark sent" only once there is something to send — without being
     * handed the content to find out.
     */
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      recipient: RECIPIENT,
      subject: SUBJECT,
    });

    expect(created.hasRecipient).toBe(true);
    expect(created.hasSubject).toBe(true);
    expect(created.hasBody).toBe(false);
    expect(created.hasStatusNote).toBe(false);

    // Nothing restricted anywhere on the object.
    const serialised = JSON.stringify(created);
    expect(serialised).not.toContain(RECIPIENT);
    expect(serialised).not.toContain(SUBJECT);
  });

  it("masks the recipient for list views (§7.7)", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      recipient: RECIPIENT,
    });

    const masked = await requests.readMaskedRecipient(userId, created.id);

    expect(masked).not.toBe(RECIPIENT);
    expect(masked).toContain("acme.example");
    expect(masked).toMatch(/•/);
  });

  it("returns null when no recipient has been entered", async () => {
    // A draft legitimately has none until Step 1 is finished.
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    expect(await requests.readMaskedRecipient(userId, created.id)).toBeNull();
  });

  it("answers NOT_FOUND-shaped null for another person's request", async () => {
    /**
     * The non-oracle rule (ATL-030): missing and foreign are indistinguishable,
     * so a guessed id cannot confirm that a request exists.
     */
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    expect(await requests.find(otherUserId, created.id)).toBeNull();
    expect(await requests.readContent(otherUserId, created.id)).toBeNull();
    expect(await requests.readMaskedRecipient(otherUserId, created.id)).toBeNull();
  });
});

describe("included_fields_json holds keys only (ADR-002, FR-08)", () => {
  it("stores approved keys", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      includedFieldKeys: ["email", "full_name"],
    });

    expect(created.includedFieldKeys).toEqual(["email", "full_name"]);
  });

  it("deduplicates whatever the caller passed", async () => {
    const created = await requests.create({
      userId,
      assetId,
      requestType: "deletion",
      includedFieldKeys: ["email", "email", "phone"],
    });

    expect(created.includedFieldKeys).toEqual(["email", "phone"]);
  });

  it("defaults to no approvals", async () => {
    /**
     * FR-08: fields are "unchecked by default and approval is per request". An
     * empty array is the honest default; a populated one would approve something
     * nobody chose.
     */
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    expect(created.includedFieldKeys).toEqual([]);
  });

  it("refuses a key outside the ADR-002 vocabulary", async () => {
    await expect(
      requests.create({
        userId,
        assetId,
        requestType: "deletion",
        includedFieldKeys: ["passport_number" as PersonalFieldKey],
      }),
    ).rejects.toThrow(UnknownPersonalFieldKeyError);
  });

  it("drops an unrecognised key on read rather than surfacing it", async () => {
    /**
     * The column is constrained only to be an array, so an unrecognised member is
     * possible from an older vocabulary or a direct edit. It degrades rather than
     * rendering a blank row — the precedent `parseOnboardingState` sets.
     */
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    await admin
      .from("data_requests")
      .update({ included_fields_json: ["email", "not_a_key"] })
      .eq("id", created.id);

    const reread = await requests.find(userId, created.id);
    expect(reread?.includedFieldKeys).toEqual(["email"]);
  });
});

describe("bounded metadata (D10)", () => {
  it("trims and stores an external reference", async () => {
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    const updated = await requests.update(userId, created.id, {
      externalReference: "  ACME-4417  ",
    });

    expect(updated?.externalReference).toBe("ACME-4417");
  });

  it("refuses one past the cap at the boundary", async () => {
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    await expect(
      requests.update(userId, created.id, { externalReference: "x".repeat(121) }),
    ).rejects.toThrow(ExternalReferenceTooLongError);
  });

  it("treats an empty reference as absent", async () => {
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    const updated = await requests.update(userId, created.id, { externalReference: "   " });
    expect(updated?.externalReference).toBeNull();
  });
});

describe("updateStatus is a write seam, not a state machine", () => {
  it("writes the status the caller decided on", async () => {
    /**
     * ATL-057 owns whether a move is legal. This repository performs the write
     * and no more, which is what keeps validation, idempotency and the two event
     * writes together upstream instead of split across two layers.
     */
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    const moved = await requests.updateStatus(userId, created.id, "draft", "ready");

    expect(moved?.status).toBe("ready");
  });

  it("matches nothing when the row has already moved", async () => {
    /**
     * The optimistic-concurrency guard. Two concurrent transitions cannot both
     * succeed: the second finds no row holding the status it validated against.
     */
    const created = await requests.create({ userId, assetId, requestType: "deletion" });
    await requests.updateStatus(userId, created.id, "draft", "ready");

    const second = await requests.updateStatus(userId, created.id, "draft", "canceled");

    expect(second).toBeNull();
  });

  it("stamps the lifecycle timestamps a transition carries", async () => {
    const created = await requests.create({ userId, assetId, requestType: "deletion" });
    await requests.updateStatus(userId, created.id, "draft", "ready");

    const sentAt = new Date().toISOString();
    const sent = await requests.updateStatus(userId, created.id, "ready", "sent", {
      sentAt,
      deliveryMethod: "copy",
    });

    expect(sent?.sentAt).not.toBeNull();
    expect(sent?.deliveryMethod).toBe("copy");
  });

  it("cannot move another person's request", async () => {
    const created = await requests.create({ userId, assetId, requestType: "deletion" });

    expect(await requests.updateStatus(otherUserId, created.id, "draft", "canceled")).toBeNull();
  });
});

describe("request events are composed, never accepted (D3)", () => {
  it("writes the template's sentence", async () => {
    const request = await requests.create({ userId, assetId, requestType: "deletion" });

    const event = await events.append({
      userId,
      requestId: request.id,
      type: "created",
      actorType: "user",
    });

    /** The caller supplied no string. The template produced it. */
    expect(event.summary).toBe("Request drafted");
    expect(event.actorType).toBe("user");
    expect(event.fromStatus).toBeNull();
  });

  it("records both ends of a transition", async () => {
    const request = await requests.create({ userId, assetId, requestType: "deletion" });

    const event = await events.append({
      userId,
      requestId: request.id,
      type: "status_changed",
      params: { fromStatus: "sent", toStatus: "awaiting_response" },
      actorType: "system",
    });

    expect(event.fromStatus).toBe("sent");
    expect(event.toStatus).toBe("awaiting_response");
    expect(event.summary).toContain("awaiting a response");
    expect(event.actorType).toBe("system");
  });

  it("refuses an unknown event type", async () => {
    const request = await requests.create({ userId, assetId, requestType: "deletion" });

    await expect(
      events.append({
        userId,
        requestId: request.id,
        type: "emailed_service" as RequestEventType,
        actorType: "user",
      }),
    ).rejects.toThrow(UnknownRequestEventTypeError);
  });

  it("refuses half a transition", async () => {
    const request = await requests.create({ userId, assetId, requestType: "deletion" });

    await expect(
      events.append({
        userId,
        requestId: request.id,
        type: "status_changed",
        params: { fromStatus: "sent" },
        actorType: "system",
      }),
    ).rejects.toThrow(IncompleteTransitionError);
  });

  it("returns a request's timeline newest first", async () => {
    const request = await requests.create({ userId, assetId, requestType: "deletion" });

    await events.append({ userId, requestId: request.id, type: "created", actorType: "user" });
    await events.append({ userId, requestId: request.id, type: "marked_ready", actorType: "user" });

    const timeline = await events.listForRequest(userId, request.id);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.eventType).toBe("marked_ready");
  });

  it("shows another person nothing", async () => {
    const request = await requests.create({ userId, assetId, requestType: "deletion" });
    await events.append({ userId, requestId: request.id, type: "created", actorType: "user" });

    expect(await events.listForRequest(otherUserId, request.id)).toEqual([]);
  });
});
