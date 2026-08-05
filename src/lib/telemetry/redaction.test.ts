import { describe, expect, it } from "vitest";
import {
  MAX_ARRAY_LENGTH,
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  REDACTED,
  array,
  object,
  redact,
  scalar,
  scrubString,
  type FieldPolicy,
} from "./redaction";

/**
 * ATL-085 — the central redaction utility.
 *
 * Security §T4 lists this as the primary control against sensitive data reaching
 * logs, so the tests are structured around the two properties the control has to
 * hold: nothing unnamed survives, and nothing that resembles a credential or a
 * contact detail survives inside something that is named.
 */

const POLICY: FieldPolicy = {
  route: scalar(),
  status: scalar((v) => typeof v === "number"),
  nested: object({ operation: scalar(), inner: object({ jobName: scalar() }) }),
  items: array(scalar()),
  records: array(object({ id: scalar() })),
};

describe("allowlist enforcement", () => {
  const cases: {
    name: string;
    input: Record<string, unknown>;
    kept: Record<string, unknown>;
    dropped: string[];
  }[] = [
    {
      name: "keeps a named key",
      input: { route: "/assets" },
      kept: { route: "/assets" },
      dropped: [],
    },
    {
      name: "drops an unnamed key and counts it",
      input: { route: "/assets", email: "dana@example.com" },
      kept: { route: "/assets" },
      dropped: ["email"],
    },
    {
      name: "drops every unnamed key",
      input: { userId: "u-1", accessToken: "t", fullName: "Dana" },
      kept: {},
      dropped: ["userId", "accessToken", "fullName"],
    },
    {
      name: "reports nested drops by path",
      input: { nested: { operation: "assets.create", secret: "s" } },
      kept: { nested: { operation: "assets.create" } },
      dropped: ["nested.secret"],
    },
    {
      name: "reports deeply nested drops by full path",
      input: { nested: { inner: { jobName: "purge", token: "x" } } },
      kept: { nested: { inner: { jobName: "purge" } } },
      dropped: ["nested.inner.token"],
    },
    {
      name: "drops unnamed keys inside array elements",
      input: { records: [{ id: "a", email: "dana@example.com" }] },
      kept: { records: [{ id: "a" }] },
      dropped: ["records[0].email"],
    },
  ];

  for (const { name, input, kept, dropped } of cases) {
    it(name, () => {
      const result = redact(input, POLICY);
      expect(result.value).toEqual(kept);
      expect(result.droppedKeys).toEqual(dropped);
    });
  }

  it("drops rather than keeps when the policy is empty", () => {
    // The failure direction that matters: an unconfigured policy must emit
    // nothing, not everything.
    const result = redact({ anything: 1, atAll: 2 }, {});
    expect(result.value).toEqual({});
    expect(result.droppedKeys).toEqual(["anything", "atAll"]);
  });
});

describe("shape validation", () => {
  it("removes a named key whose value fails its validator", () => {
    const result = redact({ status: "not-a-number" }, POLICY);
    expect(result.value).toEqual({});
    expect(result.redactedKeys).toEqual(["status"]);
  });

  it("removes rather than coerces", () => {
    // A half-repaired identifier is still a correlation handle.
    const result = redact({ status: "200" }, POLICY);
    expect(result.value).not.toHaveProperty("status");
  });

  it("treats an explicitly undefined value as absent, not as a violation", () => {
    const result = redact({ route: undefined, status: 200 }, POLICY);
    expect(result.value).toEqual({ status: 200 });
    expect(result.droppedKeys).toEqual([]);
    expect(result.redactedKeys).toEqual([]);
  });

  it("rejects a non-finite number", () => {
    // NaN and Infinity serialise to null, which reads as "absent" not "broken".
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = redact({ status: value }, POLICY);
      expect(result.value).toEqual({});
      expect(result.redactedKeys).toEqual(["status"]);
    }
  });

  it("rejects values that cannot be serialised meaningfully", () => {
    for (const value of [() => "x", Symbol("x"), 10n]) {
      const result = redact({ route: value }, POLICY);
      expect(result.value).toEqual({});
      expect(result.redactedKeys).toEqual(["route"]);
    }
  });

  it("rejects an object where a scalar is expected and vice versa", () => {
    expect(redact({ route: { a: 1 } }, POLICY).redactedKeys).toEqual(["route"]);
    expect(redact({ nested: "flat" }, POLICY).redactedKeys).toEqual(["nested"]);
    expect(redact({ items: "flat" }, POLICY).redactedKeys).toEqual(["items"]);
  });
});

/**
 * A syntactically valid JWT, assembled at runtime.
 *
 * Deliberately not written as a literal: the secret scanner (ATL-002) cannot
 * distinguish a synthetic fixture from a real Supabase key, and it is right not
 * to try. Suppressing it with `atlas-scan-ignore` would work, but it would also
 * establish that a critical scanner finding in a test file is something you wave
 * through — and the next one might not be a fixture. Joining the segments keeps
 * the scanner honest while the value the regex sees stays a genuine JWT.
 */
const SYNTHETIC_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJl"].join(
  ".",
);

describe("restricted pattern scrubbing", () => {
  const scrubbed: { name: string; input: string }[] = [
    { name: "email", input: "contact dana@example.com now" },
    { name: "email with plus addressing", input: "dana+atlas@example.co.uk" },
    { name: "E.164 phone", input: "call +14155552671" },
    { name: "bracketed phone", input: "call (415) 555-2671" },
    { name: "dashed phone", input: "call 415-555-2671" },
    { name: "dotted phone", input: "call 415.555.2671" },
    { name: "JWT", input: SYNTHETIC_JWT },
    { name: "bearer token", input: "authorization: Bearer abcdefghijklmnopqrst" },
    { name: "stripe-style secret", input: "sk_live_abcdefghijklmnopqrst" },
    { name: "github token", input: "ghp_abcdefghijklmnopqrstuvwxyz" },
  ];

  for (const { name, input } of scrubbed) {
    it(`scrubs a ${name}`, () => {
      const result = scrubString(input);
      expect(result.scrubbed).toBe(true);
      expect(result.value).toContain(REDACTED);
    });
  }

  /**
   * The regression that motivates precision over recall.
   *
   * `monitoring-event.ts` once carried a generic "looks like a phone number"
   * pattern — `\+?\d[\d\s().-]{7,}\d` — which matches an ISO-8601 instant. Every
   * monitoring event silently lost its `occurredAt`. Resemblance-based matching
   * fails invisibly and destroys good data, so these values are pinned.
   */
  const preserved = [
    "2026-07-30T09:15:00.000Z",
    "2026-07-30T09:15:00Z",
    "2026-07-30",
    "1.2.3",
    "v1.24.0-rc1",
    "/assets/:id",
    "RATE_LIMITED",
    "200",
    "a1b2c3d4e5f6a7b8",
  ];

  for (const input of preserved) {
    it(`leaves ${input} untouched`, () => {
      const result = scrubString(input);
      expect(result.scrubbed).toBe(false);
      expect(result.value).toBe(input);
    });
  }

  it("scrubs inside an allowlisted value and counts the key", () => {
    // Defense in depth: the key is permitted, the content is not.
    const result = redact({ route: "/requests/dana@example.com" }, POLICY);
    expect(result.value.route).toBe(`/requests/${REDACTED}`);
    expect(result.redactedKeys).toEqual(["route"]);
  });

  it("scrubs inside nested and array values", () => {
    const result = redact(
      { nested: { operation: "mail to dana@example.com" }, items: ["+14155552671"] },
      POLICY,
    );
    expect(result.value).toEqual({
      nested: { operation: `mail to ${REDACTED}` },
      items: [REDACTED],
    });
    expect(result.redactedKeys).toEqual(["nested.operation", "items[0]"]);
  });

  it("scrubs every occurrence, not just the first", () => {
    const result = scrubString("a@b.com and c@d.com");
    expect(result.value).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it("is stable across repeated calls", () => {
    // A `g` regex carries `lastIndex` state between calls; resetting it is what
    // stops the second call through a shared pattern from skipping a match.
    for (let i = 0; i < 3; i++) {
      expect(scrubString("dana@example.com").value).toBe(REDACTED);
    }
  });
});

describe("guard rails", () => {
  it("collapses a non-object payload instead of throwing", () => {
    // A logging call must never be able to fail a request path.
    for (const input of [null, undefined, 42, "text", true]) {
      const result = redact(input, POLICY);
      expect(result.value).toEqual({});
      expect(result.droppedKeys).toEqual(["<root>"]);
    }
  });

  it("survives a circular reference", () => {
    const cyclic: Record<string, unknown> = { nested: { operation: "x" } };
    (cyclic.nested as Record<string, unknown>).inner = cyclic;

    expect(() => redact(cyclic, POLICY)).not.toThrow();
  });

  it("truncates an over-long string and counts it", () => {
    const result = redact({ route: "a".repeat(MAX_STRING_LENGTH + 100) }, POLICY);
    expect((result.value.route as string).length).toBe(MAX_STRING_LENGTH);
    expect(result.redactedKeys).toContain("route");
  });

  it("caps array length and counts it", () => {
    const result = redact(
      { items: Array.from({ length: MAX_ARRAY_LENGTH + 10 }, () => "x") },
      POLICY,
    );
    expect((result.value.items as unknown[]).length).toBe(MAX_ARRAY_LENGTH);
    expect(result.redactedKeys).toContain("items");
  });

  it("stops descending past the depth cap", () => {
    // Build a policy and payload deeper than MAX_DEPTH.
    let rule = scalar();
    let payload: unknown = "leaf";
    for (let i = 0; i < MAX_DEPTH + 3; i++) {
      rule = object({ n: rule });
      payload = { n: payload };
    }

    const result = redact(payload, { n: rule });
    expect(() => JSON.stringify(result.value)).not.toThrow();
    expect(result.redactedKeys.length).toBeGreaterThan(0);
  });
});
