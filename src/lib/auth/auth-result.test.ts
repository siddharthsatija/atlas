import { describe, expect, it } from "vitest";
import {
  isPlausibleEmail,
  toCallbackResultCode,
  toMagicLinkResultCode,
  toSessionCheckStatus,
  type MagicLinkResultCode,
} from "./auth-result";

/**
 * ATL-011 — registration-neutral messaging.
 *
 * Security §5: "Do not reveal whether an email address is registered." These tests
 * are written from the attacker's side: for every provider outcome that *knows*
 * something about the account, assert the caller learns nothing.
 */

describe("isPlausibleEmail", () => {
  it.each(["user@example.com", "first.last+tag@sub.example.co.uk", "a@b.co"])(
    "accepts %s",
    (value) => {
      expect(isPlausibleEmail(value)).toBe(true);
    },
  );

  it.each(["", "   ", "no-at-sign", "user@", "@example.com", "user@localhost", "a b@example.com"])(
    "rejects %s",
    (value) => {
      expect(isPlausibleEmail(value)).toBe(false);
    },
  );

  it("rejects an address beyond the maximum length", () => {
    expect(isPlausibleEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });

  it("never consults anything but the string", () => {
    // A format check by construction: same answer for a registered-looking and
    // an unregistered-looking address.
    expect(isPlausibleEmail("known@example.com")).toBe(isPlausibleEmail("unknown@example.com"));
  });
});

describe("toMagicLinkResultCode — registration neutrality", () => {
  it.each([
    "user_not_found",
    "signup_disabled",
    "email_not_confirmed",
    "user_banned",
    "identity_already_exists",
    "email_exists",
  ])("reports %s as an ordinary send", (code) => {
    // Each of these tells the caller something about the *account*. All must be
    // indistinguishable from success.
    expect(toMagicLinkResultCode({ code })).toBe<MagicLinkResultCode>("verification_sent");
  });

  it("returns the same code for success and for an unknown address", () => {
    const success = toMagicLinkResultCode(null);
    const unknownAddress = toMagicLinkResultCode({ code: "user_not_found" });
    expect(success).toBe(unknownAddress);
  });

  it.each(["over_email_send_rate_limit", "over_request_rate_limit"])(
    "surfaces %s, which is independent of registration",
    (code) => {
      expect(toMagicLinkResultCode({ code })).toBe("rate_limited");
    },
  );

  it.each(["validation_failed", "email_address_invalid", "email_address_not_authorized"])(
    "surfaces %s as an invalid address",
    (code) => {
      // Properties of the address, not of an account — no lookup involved.
      expect(toMagicLinkResultCode({ code })).toBe("invalid_email");
    },
  );

  it("treats an unrecognised provider failure as unavailable", () => {
    expect(toMagicLinkResultCode({ code: "internal_server_error" })).toBe("unavailable");
    expect(toMagicLinkResultCode(new Error("boom"))).toBe("unavailable");
  });

  it("returns a code from the closed set for any input", () => {
    const allowed: MagicLinkResultCode[] = [
      "verification_sent",
      "invalid_email",
      "rate_limited",
      "unavailable",
    ];
    for (const input of [null, undefined, {}, "string", 42, [], { code: 1 }, new Error("x")]) {
      expect(allowed).toContain(toMagicLinkResultCode(input));
    }
  });

  it("never carries provider text through", () => {
    // The result is a code, not a message — there is no field to forward into.
    const code = toMagicLinkResultCode({
      code: "user_not_found",
      message: "User dana@example.com was not found",
    });
    expect(JSON.stringify({ code })).not.toContain("dana@example.com");
  });

  it("survives a hostile error object", () => {
    const hostile = {
      get code() {
        throw new Error("nope");
      },
    };
    expect(() => toMagicLinkResultCode(hostile)).not.toThrow();
    expect(toMagicLinkResultCode(hostile)).toBe("unavailable");
  });
});

describe("toCallbackResultCode", () => {
  it("reports success when there is no error", () => {
    expect(toCallbackResultCode(null)).toBe("session_established");
    expect(toCallbackResultCode(undefined)).toBe("session_established");
  });

  it.each([
    "otp_expired",
    "flow_state_expired",
    "flow_state_not_found",
    "bad_code_verifier",
    "validation_failed",
    "unexpected_failure",
  ])("collapses %s into one link failure", (code) => {
    // Distinguishing expired from never-valid tells a holder of a stolen link
    // whether it was ever real. The user's recovery is identical either way.
    expect(toCallbackResultCode({ code })).toBe("link_invalid_or_expired");
  });

  it("does not treat a rate limit as a bad link", () => {
    // Telling the user their link is invalid when it is fine would send them
    // round the loop generating more links against the same limit.
    expect(toCallbackResultCode({ code: "over_request_rate_limit" })).toBe("unavailable");
  });
});

describe("toSessionCheckStatus (ATL-111)", () => {
  /**
   * Keyed on HTTP status rather than on Supabase's error-code vocabulary, which
   * the magic-link mappers above use. The question here is narrower and the
   * status answers it exactly: did the auth server reach a verdict about this
   * token, or did it not answer at all?
   */

  it.each([400, 401, 403, 404, 422])("reads %i as a verdict: no session", (status) => {
    expect(toSessionCheckStatus({ status })).toBe("unauthenticated");
  });

  it.each([500, 502, 503, 504])("reads %i as the provider not answering", (status) => {
    expect(toSessionCheckStatus({ status })).toBe("unavailable");
  });

  it("reads 429 as the provider declining to answer, not as a sign-out", () => {
    /**
     * A rate limit says nothing whatever about the session — and locally it is
     * the most likely cause, since a full E2E run can exhaust the hourly limits
     * in `supabase/config.toml`. Treating it as a sign-out is how a signed-in
     * user ends up looking at a sign-in form.
     */
    expect(toSessionCheckStatus({ status: 429 })).toBe("unavailable");
  });

  it("reads a statusless error as the provider not answering", () => {
    // A transport failure has no HTTP status because no response arrived.
    expect(toSessionCheckStatus({ name: "AuthRetryableFetchError" })).toBe("unavailable");
    expect(toSessionCheckStatus(new Error("ECONNREFUSED"))).toBe("unavailable");
  });

  it("defaults an unrecognisable failure to unavailable", () => {
    /**
     * Both outcomes deny access, so this default cannot weaken anything — the
     * only difference is what the user is told, and Atlas should not claim
     * somebody is signed out on evidence it does not have.
     */
    for (const error of [undefined, null, "boom", 42, {}, { status: "503" }, { status: NaN }]) {
      expect(toSessionCheckStatus(error)).toBe("unavailable");
    }
  });

  it("survives an error object that throws when read", () => {
    // The value crosses a provider boundary as `unknown`; a throwing getter
    // here would surface inside the auth gate itself.
    const hostile = {
      get status(): number {
        throw new Error("no");
      },
    };

    expect(toSessionCheckStatus(hostile)).toBe("unavailable");
  });

  it("never reports authenticated", () => {
    // The type says so; this is the runtime statement of the same rule. This
    // function only ever classifies a failure.
    const statuses = [400, 401, 429, 500, undefined].map((status) =>
      toSessionCheckStatus({ status }),
    );

    expect(statuses).not.toContain("authenticated");
  });
});
