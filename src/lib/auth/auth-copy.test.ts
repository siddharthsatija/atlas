import { describe, expect, it } from "vitest";
import {
  MAGIC_LINK_MESSAGES,
  SIGN_IN_METHOD_NOTE,
  SIGN_IN_PURPOSE,
  SIGN_IN_REASON_MESSAGES,
  parseSignInReason,
} from "./auth-copy";
import type { MagicLinkResultCode } from "./auth-result";

/**
 * ATL-014 — authentication copy.
 *
 * Copy is tested as data because two of its properties are security properties,
 * not stylistic ones: it must never disclose registration status, and it must
 * never make a security claim the product cannot honour.
 */

const ALL_MAGIC_LINK_CODES: MagicLinkResultCode[] = [
  "verification_sent",
  "invalid_email",
  "rate_limited",
  "unavailable",
];

describe("coverage", () => {
  it.each(ALL_MAGIC_LINK_CODES)("has copy for the %s result", (code) => {
    // A missing entry would render `undefined` on the screen.
    const message = MAGIC_LINK_MESSAGES[code];
    expect(message.title.length).toBeGreaterThan(0);
    expect(message.description.length).toBeGreaterThan(0);
  });

  it.each(["link_invalid_or_expired", "unavailable", "session_idle", "session_expired"] as const)(
    "has copy for the %s redirect reason",
    (reason) => {
      expect(SIGN_IN_REASON_MESSAGES[reason].description.length).toBeGreaterThan(0);
    },
  );
});

describe("registration neutrality", () => {
  it("never states that an account does or does not exist", () => {
    const everything = [
      ...Object.values(MAGIC_LINK_MESSAGES),
      ...Object.values(SIGN_IN_REASON_MESSAGES),
    ]
      .flatMap((message) => [message.title, message.description])
      .join(" ")
      .toLowerCase();

    for (const phrase of [
      "no account",
      "not registered",
      "already registered",
      "account exists",
      "sign up",
      "create an account",
      "unknown email",
      "we don't recognise",
      "we don't recognize",
    ]) {
      expect(everything).not.toContain(phrase);
    }
  });

  it("hedges the verification message on deliverability, not on identity", () => {
    // "If that address can receive a link" is true and discloses nothing —
    // Atlas genuinely does not check for an account before sending.
    const { description } = MAGIC_LINK_MESSAGES.verification_sent;
    expect(description.toLowerCase()).toContain("if that address");
  });

  it("does not promise that a link was definitely sent", () => {
    // An unconditional "we've sent you a link" would be a small lie for an
    // address that cannot receive one.
    expect(MAGIC_LINK_MESSAGES.verification_sent.description.toLowerCase()).not.toMatch(
      /^we(?:'ve| have) sent/,
    );
  });
});

describe("no misleading security claims", () => {
  it("makes no claim Atlas cannot honour", () => {
    const everything = [
      SIGN_IN_PURPOSE,
      SIGN_IN_METHOD_NOTE,
      ...Object.values(MAGIC_LINK_MESSAGES).flatMap((m) => [m.title, m.description]),
      ...Object.values(SIGN_IN_REASON_MESSAGES).flatMap((m) => [m.title, m.description]),
    ]
      .join(" ")
      .toLowerCase();

    // Frontend §16 and the product honesty rules: no unearned assurance.
    for (const claim of [
      "end-to-end",
      "end to end",
      "military",
      "bank-level",
      "completely secure",
      "100%",
      "guaranteed",
      "unhackable",
      "we scan",
    ]) {
      expect(everything).not.toContain(claim);
    }
  });

  it("explains why an account is needed without overclaiming", () => {
    // Frontend §16 requires the explanation; the honesty rules forbid saying
    // Atlas scans or deletes anything on the user's behalf.
    expect(SIGN_IN_PURPOSE.length).toBeGreaterThan(40);
    expect(SIGN_IN_PURPOSE.toLowerCase()).not.toContain("delete");
    expect(SIGN_IN_PURPOSE.toLowerCase()).not.toContain("scan");
  });

  it("uses calm language throughout", () => {
    const everything = [
      ...Object.values(MAGIC_LINK_MESSAGES),
      ...Object.values(SIGN_IN_REASON_MESSAGES),
    ]
      .flatMap((m) => [m.title, m.description])
      .join(" ");

    // Frontend §23: calm, nonjudgmental. No exclamation, no alarm words.
    expect(everything).not.toContain("!");
    expect(everything.toLowerCase()).not.toMatch(/\b(error|failed|invalid credentials|denied)\b/);
  });
});

describe("parseSignInReason", () => {
  it.each(["link_invalid_or_expired", "unavailable", "session_idle", "session_expired"] as const)(
    "accepts the known reason %s",
    (reason) => {
      expect(parseSignInReason(reason)).toBe(reason);
    },
  );

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["unknown code", "made_up_reason"],
    ["injected markup", "<script>alert(1)</script>"],
    ["arbitrary sentence", "Your account was deleted"],
    ["case variant", "SESSION_IDLE"],
  ])("rejects %s", (_label, value) => {
    // The parameter is attacker-controlled: an open vocabulary would let anyone
    // craft a link that puts arbitrary text on the sign-in screen.
    expect(parseSignInReason(value)).toBeNull();
  });
});
