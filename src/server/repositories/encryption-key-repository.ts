import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { CryptoError } from "@/server/crypto/envelope";

/**
 * Data access for `user_encryption_keys` (ATL-084).
 *
 * The only module that reads or writes wrapped key material. It deals in wrapped
 * DEKs exclusively — an unwrapped key never enters or leaves this file, so a
 * repository bug cannot put a usable key somewhere it does not belong.
 *
 * Requires the service-role client: the table has RLS enabled with no policies,
 * so no other role can reach it at all.
 */

export type KeyStatus = "active" | "retired" | "destroyed";

/** A key row as this layer exposes it. `wrappedDek` is null only when destroyed. */
export interface EncryptionKeyRecord {
  id: string;
  userId: string;
  wrappedDek: string | null;
  kekVersion: number;
  status: KeyStatus;
  destroyedAt: string | null;
}

type KeyRow = Database["public"]["Tables"]["user_encryption_keys"]["Row"];

function toRecord(row: KeyRow): EncryptionKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    wrappedDek: row.wrapped_dek,
    kekVersion: row.kek_version,
    status: row.status as KeyStatus,
    destroyedAt: row.destroyed_at,
  };
}

/**
 * Translates a database failure into a code.
 *
 * PostgREST error text can quote column values, so it is never forwarded. The
 * caller learns that key access failed and nothing more — which is all it can
 * act on anyway.
 */
function failClosed(): never {
  throw new CryptoError("key_unavailable");
}

export class EncryptionKeyRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Every key row the user holds, in any status.
   *
   * Deliberately unfiltered, and deliberately not accompanied by a
   * `findActive` convenience. A status-filtered lookup cannot distinguish
   * "this user has never held a key" from "this user's key was destroyed" —
   * both come back as `null` — and the caller that has to make that distinction
   * is the one deciding whether to mint a new DEK. Filtering here once caused
   * exactly that: a crypto-shredded user was silently re-keyed on their next
   * read, because absence read as "first write". The service now classifies the
   * rows itself.
   *
   * A user accumulates one active key plus a bounded number of retired or
   * destroyed ones, so this stays a single small read.
   */
  async findForUser(userId: string): Promise<EncryptionKeyRecord[]> {
    const { data, error } = await this.db
      .from("user_encryption_keys")
      .select("*")
      .eq("user_id", userId);

    if (error) failClosed();
    return (data ?? []).map(toRecord);
  }

  /** A specific key by id, used to read rows written under a retired DEK. */
  async findById(userId: string, id: string): Promise<EncryptionKeyRecord | null> {
    const { data, error } = await this.db
      .from("user_encryption_keys")
      .select("*")
      // Scoped by user as well as id: this client bypasses RLS, so ownership is
      // filtered here or not at all.
      .eq("user_id", userId)
      .eq("id", id)
      .maybeSingle();

    if (error) failClosed();
    return data ? toRecord(data) : null;
  }

  /**
   * Inserts a new active key.
   *
   * A concurrent caller racing to create the first DEK will violate the unique
   * partial index rather than produce a second active key. The caller treats
   * that as "someone else won" and re-reads — splitting a user's data across two
   * keys would leave half of it surviving a crypto-shred.
   */
  async insertActive(
    userId: string,
    wrappedDek: string,
    kekVersion: number,
  ): Promise<EncryptionKeyRecord | null> {
    const { data, error } = await this.db
      .from("user_encryption_keys")
      .insert({ user_id: userId, wrapped_dek: wrappedDek, kek_version: kekVersion })
      .select("*")
      .maybeSingle();

    // A unique violation is an expected race, not a fault: null tells the caller
    // to re-read rather than retry blindly.
    if (error) return null;
    return data ? toRecord(data) : null;
  }

  /** Every key still holding material, for a KEK rotation sweep. */
  async listWrappedUnder(kekVersion: number, limit: number): Promise<EncryptionKeyRecord[]> {
    const { data, error } = await this.db
      .from("user_encryption_keys")
      .select("*")
      .eq("kek_version", kekVersion)
      .neq("status", "destroyed")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) failClosed();
    return (data ?? []).map(toRecord);
  }

  /**
   * Replaces the wrapped material with the same DEK under a newer KEK.
   *
   * Guarded on the expected `kek_version` so a concurrent sweep cannot re-wrap
   * the same row twice or overwrite a newer wrapping with an older one. The
   * update is therefore idempotent, which is what makes the sweep resumable.
   */
  async rewrap(
    id: string,
    expectedKekVersion: number,
    wrappedDek: string,
    kekVersion: number,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from("user_encryption_keys")
      .update({ wrapped_dek: wrappedDek, kek_version: kekVersion })
      .eq("id", id)
      .eq("kek_version", expectedKekVersion)
      .neq("status", "destroyed")
      .select("id");

    if (error) failClosed();
    return (data ?? []).length === 1;
  }

  /**
   * Crypto-shredding: destroys every key the user holds.
   *
   * Clears the wrapped material and marks the row destroyed in one statement, so
   * there is no window in which a row reads as active with no key. The table's
   * check constraint refuses any other combination.
   *
   * Irreversible by construction — the wrapped DEK is the only copy, and once
   * overwritten the ciphertext it protected cannot be read again by anyone,
   * including from provider backups (security §16 step 5).
   */
  async destroyAllForUser(userId: string, destroyedAt: string): Promise<number> {
    const { data, error } = await this.db
      .from("user_encryption_keys")
      .update({ wrapped_dek: null, status: "destroyed", destroyed_at: destroyedAt })
      .eq("user_id", userId)
      .neq("status", "destroyed")
      .select("id");

    if (error) failClosed();
    return (data ?? []).length;
  }
}
