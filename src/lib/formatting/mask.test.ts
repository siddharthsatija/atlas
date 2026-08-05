import { describe, expect, it } from "vitest";
import { maskEmail, maskIdentifier, maskPhone, maskValue } from "./mask";

/**
 * ATL-069 — identifier masking (security §8: "Mask identifiers by default").
 *
 * Every test here is really the same question asked of different inputs: can the
 * original be reconstructed from the output? Masking that leaks is worse than no
 * masking, because it looks handled.
 */

describe("maskEmail", () => {
  it("keeps the domain and the ends of the local part", () => {
    // Enough for the owner to tell their addresses apart, not enough to guess one.
    expect(maskEmail("dana@example.com")).toBe("d••••a@example.com");
  });

  it("masks a short local part entirely", () => {
    // Keeping "both ends" of a two-character string would return it verbatim.
    expect(maskEmail("jo@example.com")).toBe("••••@example.com");
    expect(maskEmail("j@example.com")).toBe("••••@example.com");
  });

  it("handles plus addressing and subdomains", () => {
    expect(maskEmail("dana+atlas@mail.example.co.uk")).toBe("d••••s@mail.example.co.uk");
  });

  it("uses the last @ so an address in the local part cannot confuse it", () => {
    expect(maskEmail("a@b@example.com")).toBe("a••••b@example.com");
  });

  it("masks opaquely when the input is not an address", () => {
    for (const input of ["not-an-email", "@example.com", "dana@", ""]) {
      expect(maskEmail(input)).not.toContain("dana");
    }
  });
});

describe("maskPhone", () => {
  it("keeps the last four digits", () => {
    expect(maskPhone("+1 (415) 555-4821")).toBe("••••4821");
  });

  it("masks the same number identically however it is written", () => {
    // Otherwise one number appears two different ways in one timeline.
    const written = ["+14155554821", "+1 (415) 555-4821", "415.555.4821", "1-415-555-4821"];
    const masked = new Set(written.map(maskPhone));
    expect(masked.size).toBe(1);
  });

  it("masks a too-short value opaquely", () => {
    expect(maskPhone("12")).toBe("••••••");
  });
});

describe("maskIdentifier", () => {
  it("keeps the last four characters", () => {
    expect(maskIdentifier("ACCT-000-4821")).toBe("••••4821");
  });

  it("masks a short identifier entirely", () => {
    // Keeping the last four of a five-character value reveals almost all of it.
    expect(maskIdentifier("ab4821")).toBe("••••••");
  });
});

describe("maskValue", () => {
  it("routes by detected kind", () => {
    expect(maskValue("dana@example.com")).toBe("d••••a@example.com");
    expect(maskValue("+1 (415) 555-4821")).toBe("••••4821");
    expect(maskValue("ACCT-000-4821")).toBe("••••4821");
  });

  it("masks an unrecognised value opaquely rather than passing it through", () => {
    /**
     * The failure direction that matters. Returning the input when unsure would
     * make the convenient call the dangerous one — a caller reaching for
     * `maskValue` has already decided the value is sensitive.
     */
    expect(maskValue("Dana Whitfield")).not.toContain("Dana");
    expect(maskValue("   ")).toBe("••••••");
  });

  it("never returns the input unchanged for a restricted value", () => {
    for (const input of ["dana@example.com", "+14155554821", "ACCT-000-4821", "Dana Whitfield"]) {
      expect(maskValue(input)).not.toBe(input);
    }
  });
});
