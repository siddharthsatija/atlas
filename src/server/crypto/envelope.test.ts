import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CryptoError,
  ENVELOPE_VERSION,
  KEY_BYTES,
  NONCE_BYTES,
  buildAad,
  generateDek,
  keysEqual,
  open,
  seal,
  unwrapDek,
  wrapDek,
  zeroize,
  type EncryptionContext,
} from "./envelope";

/**
 * ATL-084 — envelope primitives.
 *
 * Written from the attacker's side: for every way ciphertext could be moved,
 * altered, or decrypted with the wrong key, assert it fails closed. A crypto
 * module that only proves round-trip proves almost nothing.
 */

const KEY = Buffer.alloc(KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(KEY_BYTES, 9);

const CONTEXT: EncryptionContext = {
  table: "digital_assets",
  column: "account_identifier_encrypted",
  recordId: "8f14e45f-ceea-467a-9dbf-2a0e1b7e4a11",
};

const SECRET = "dana@example.com";

/** Fails the test if the operation succeeds; returns the code if it throws. */
function failureCodeOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  throw new Error("expected the operation to fail closed, but it succeeded");
}

describe("round trip", () => {
  it("recovers the plaintext with the right key and context", () => {
    expect(open(KEY, seal(KEY, SECRET, CONTEXT), CONTEXT)).toBe(SECRET);
  });

  it.each([
    ["empty string", ""],
    ["unicode", "Ana Müller · 東京 · 🙂"],
    ["long value", "x".repeat(8192)],
    ["json", JSON.stringify({ email: "dana@example.com", note: "delete me" })],
  ])("round-trips %s", (_label, value) => {
    expect(open(KEY, seal(KEY, value, CONTEXT), CONTEXT)).toBe(value);
  });

  it("produces a different ciphertext every time", () => {
    // A fresh random nonce per value. Deterministic output would leak equality
    // between rows — that two users hold the same address, for instance.
    const first = seal(KEY, SECRET, CONTEXT);
    const second = seal(KEY, SECRET, CONTEXT);
    expect(first).not.toBe(second);
    expect(open(KEY, second, CONTEXT)).toBe(SECRET);
  });

  it("never contains the plaintext", () => {
    const envelope = seal(KEY, SECRET, CONTEXT);
    expect(envelope).not.toContain(SECRET);
    expect(envelope).not.toContain("dana");
    // Nor the key, in any encoding.
    expect(envelope).not.toContain(KEY.toString("base64url"));
  });

  it("declares its format", () => {
    expect(seal(KEY, SECRET, CONTEXT).startsWith(`atlas.${ENVELOPE_VERSION}.`)).toBe(true);
  });
});

describe("wrong key", () => {
  it("fails rather than returning anything", () => {
    const envelope = seal(KEY, SECRET, CONTEXT);
    expect(failureCodeOf(() => open(OTHER_KEY, envelope, CONTEXT))).toBe("integrity_failure");
  });

  it.each([
    ["too short", 16],
    ["too long", 48],
    ["empty", 0],
  ])("rejects a %s key", (_label, length) => {
    expect(failureCodeOf(() => seal(Buffer.alloc(length), SECRET, CONTEXT))).toBe("invalid_key");
  });
});

describe("AAD binding — ciphertext cannot move", () => {
  it("cannot be read from a different row", () => {
    // The core guarantee of ADR-003: an operator who copies a ciphertext into
    // another user's row gets an unreadable value, not that user's data.
    const envelope = seal(KEY, SECRET, CONTEXT);
    const otherRow = { ...CONTEXT, recordId: "00000000-0000-4000-8000-000000000000" };

    expect(failureCodeOf(() => open(KEY, envelope, otherRow))).toBe("integrity_failure");
  });

  it("cannot be read from a different column", () => {
    const envelope = seal(KEY, SECRET, CONTEXT);
    const otherColumn = { ...CONTEXT, column: "recipient_encrypted" };

    expect(failureCodeOf(() => open(KEY, envelope, otherColumn))).toBe("integrity_failure");
  });

  it("cannot be read from a different table", () => {
    const envelope = seal(KEY, SECRET, CONTEXT);
    const otherTable = { ...CONTEXT, table: "data_requests" };

    expect(failureCodeOf(() => open(KEY, envelope, otherTable))).toBe("integrity_failure");
  });

  it("builds the documented AAD shape", () => {
    // security §8: `table.column:record_id`.
    expect(buildAad(CONTEXT).toString("utf8")).toBe(
      "digital_assets.account_identifier_encrypted:8f14e45f-ceea-467a-9dbf-2a0e1b7e4a11",
    );
  });

  it.each([
    ["empty table", { ...CONTEXT, table: "" }],
    ["empty column", { ...CONTEXT, column: "  " }],
    ["empty record id", { ...CONTEXT, recordId: "" }],
  ])("rejects %s rather than binding to less than it appears", (_label, context) => {
    expect(failureCodeOf(() => buildAad(context))).toBe("invalid_aad");
  });

  it("rejects separators inside the parts", () => {
    // Otherwise `table = "a.b"` could impersonate another column's binding.
    expect(failureCodeOf(() => buildAad({ ...CONTEXT, table: "a.b" }))).toBe("invalid_aad");
    expect(failureCodeOf(() => buildAad({ ...CONTEXT, column: "a:b" }))).toBe("invalid_aad");
  });
});

describe("tampering", () => {
  it("rejects a flipped ciphertext bit", () => {
    const envelope = seal(KEY, SECRET, CONTEXT);
    const parts = envelope.split(".");
    const payload = Buffer.from(parts[3] as string, "base64url");
    payload[0] = (payload[0] ?? 0) ^ 0x01;
    parts[3] = payload.toString("base64url");

    expect(failureCodeOf(() => open(KEY, parts.join("."), CONTEXT))).toBe("integrity_failure");
  });

  it("rejects a replaced nonce", () => {
    const parts = seal(KEY, SECRET, CONTEXT).split(".");
    parts[2] = randomBytes(NONCE_BYTES).toString("base64url");

    expect(failureCodeOf(() => open(KEY, parts.join("."), CONTEXT))).toBe("integrity_failure");
  });

  it("rejects a stripped authentication tag", () => {
    const parts = seal(KEY, SECRET, CONTEXT).split(".");
    const payload = Buffer.from(parts[3] as string, "base64url");
    parts[3] = payload.subarray(0, payload.length - 16).toString("base64url");

    // Too short to hold a tag at all — caught structurally.
    expect(["invalid_envelope", "integrity_failure"]).toContain(
      failureCodeOf(() => open(KEY, parts.join("."), CONTEXT)),
    );
  });

  it("rejects a swapped payload from another value", () => {
    const a = seal(KEY, "first", CONTEXT).split(".");
    const b = seal(KEY, "second", CONTEXT).split(".");
    // Nonce from one, payload from the other.
    const frankenstein = [a[0], a[1], a[2], b[3]].join(".");

    expect(failureCodeOf(() => open(KEY, frankenstein, CONTEXT))).toBe("integrity_failure");
  });
});

describe("malformed envelopes fail closed", () => {
  it.each([
    ["empty", ""],
    ["plain text", "just a string"],
    ["too few parts", "atlas.v1.abc"],
    ["too many parts", "atlas.v1.a.b.c"],
    ["wrong prefix", "notatlas.v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA"],
    ["non-base64url nonce", "atlas.v1.!!!!.AAAAAAAAAAAAAAAAAAAAAA"],
    ["short nonce", `atlas.v1.${Buffer.alloc(4).toString("base64url")}.AAAAAAAAAAAAAAAAAAAAAA`],
  ])("rejects %s", (_label, envelope) => {
    expect(failureCodeOf(() => open(KEY, envelope, CONTEXT))).toBe("invalid_envelope");
  });

  it("reports an unknown format version distinctly", () => {
    // Distinct from corruption: a v2 value in a v1 build is a deployment
    // problem, and reading it as tampering would send an incident the wrong way.
    const envelope = seal(KEY, SECRET, CONTEXT).replace("atlas.v1.", "atlas.v2.");
    expect(failureCodeOf(() => open(KEY, envelope, CONTEXT))).toBe("unsupported_version");
  });
});

describe("errors disclose nothing", () => {
  it("carries only a code", () => {
    const error = new CryptoError("integrity_failure");
    expect(error.message).toBe("integrity_failure");
    expect(JSON.stringify(error)).toBe('{"name":"CryptoError","code":"integrity_failure"}');
  });

  it("never includes plaintext, ciphertext, or key material", () => {
    const envelope = seal(KEY, SECRET, CONTEXT);
    try {
      open(OTHER_KEY, envelope, CONTEXT);
      throw new Error("expected failure");
    } catch (error) {
      const serialised = `${String(error)}${JSON.stringify(error)}${(error as Error).stack ?? ""}`;
      expect(serialised).not.toContain(SECRET);
      expect(serialised).not.toContain(envelope);
      expect(serialised).not.toContain(KEY.toString("base64"));
      expect(serialised).not.toContain(CONTEXT.recordId);
    }
  });
});

describe("DEK wrapping", () => {
  const KEK = Buffer.alloc(KEY_BYTES, 3);
  const USER = "11111111-1111-4111-8111-111111111111";
  const OTHER_USER = "22222222-2222-4222-8222-222222222222";

  it("round-trips a DEK", () => {
    const dek = generateDek();
    const wrapped = wrapDek(KEK, dek, USER, 1);

    expect(keysEqual(unwrapDek(KEK, wrapped, USER, 1), dek)).toBe(true);
  });

  it("generates a distinct 256-bit key each time", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a).toHaveLength(KEY_BYTES);
    expect(keysEqual(a, b)).toBe(false);
  });

  it("never exposes the raw DEK in the wrapped form", () => {
    const dek = generateDek();
    const wrapped = wrapDek(KEK, dek, USER, 1);

    expect(wrapped).not.toContain(dek.toString("base64"));
    expect(wrapped).not.toContain(dek.toString("base64url"));
    expect(wrapped).not.toContain(dek.toString("hex"));
  });

  it("cannot be unwrapped onto a different user", () => {
    // A key row copied between users must not yield a usable key — otherwise an
    // operator with write access could read another account's data.
    const wrapped = wrapDek(KEK, generateDek(), USER, 1);
    expect(failureCodeOf(() => unwrapDek(KEK, wrapped, OTHER_USER, 1))).toBe("integrity_failure");
  });

  it("cannot be unwrapped under a different KEK generation", () => {
    // The stored kek_version must match the KEK actually used; a mismatch is
    // caught rather than silently producing rubbish.
    const wrapped = wrapDek(KEK, generateDek(), USER, 1);
    expect(failureCodeOf(() => unwrapDek(KEK, wrapped, USER, 2))).toBe("integrity_failure");
  });

  it("cannot be unwrapped with the wrong KEK", () => {
    const wrapped = wrapDek(KEK, generateDek(), USER, 1);
    expect(failureCodeOf(() => unwrapDek(OTHER_KEY, wrapped, USER, 1))).toBe("integrity_failure");
  });

  it("rejects an invalid KEK version", () => {
    expect(failureCodeOf(() => wrapDek(KEK, generateDek(), USER, 0))).toBe("invalid_aad");
  });
});

describe("zeroize", () => {
  it("overwrites the buffer", () => {
    const dek = generateDek();
    zeroize(dek);
    expect(keysEqual(dek, Buffer.alloc(KEY_BYTES))).toBe(true);
  });
});
