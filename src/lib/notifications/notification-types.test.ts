import { describe, expect, it } from "vitest";
import { scrubString } from "@/lib/telemetry/redaction";
import {
  buildNotificationBody,
  buildNotificationTitle,
  defaultEnabled,
  isConfigurable,
  isNotificationType,
  resolveEnabled,
  CONFIGURABLE_NOTIFICATION_TYPES,
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_TYPES,
  type NotificationParams,
  type NotificationType,
} from "./notification-types";

/**
 * ATL-107 — the notification vocabulary, its defaults, and its templates.
 *
 * Three things are asserted here because they are decisions rather than
 * mechanics: that the vocabulary is exactly ADR-005's five types, that the
 * defaults and configurability match D2, and that no template can produce a
 * string carrying a restricted value.
 *
 * The last one is the reason this file matters. `notifications.body` is the only
 * user-visible free text in the notification system, and FR-14 forbids personal
 * values and draft text in it. The service scans what it composes as defence in
 * depth; these tests attack the templates directly, so a template that *could*
 * leak fails here rather than waiting for a caller to prove it.
 */

/** Every parameter a template may read, each carrying a plausible hostile value. */
const HOSTILE: Required<NotificationParams> = {
  service: "alex.person@example.com",
  label: "+1 (202) 555-0134",
  status: "sk-live-0123456789abcdefghij",
  fromStatus: "alex.person@example.com",
  toStatus: "+1 (202) 555-0134",
  severity: "alex.person@example.com",
  count: 3,
  days: 7,
};

const SAFE: NotificationParams = {
  service: "Acme Media",
  label: "Work email",
  status: "sent",
  fromStatus: "sent",
  toStatus: "awaiting response",
  severity: "high",
  count: 2,
  days: 3,
};

describe("the vocabulary", () => {
  it("is exactly the five types ADR-005 and architecture §7.14 name", () => {
    /**
     * Asserted as a set rather than a length. A sixth type is a product decision
     * that needs this file, the check constraint in the migration, and a
     * documented default — so it should fail here first.
     */
    expect([...NOTIFICATION_TYPES].sort()).toEqual([
      "finding_new",
      "follow_up_due",
      "request_status",
      "security",
      "system",
    ]);
  });

  it("recognises its own members and nothing else", () => {
    for (const type of NOTIFICATION_TYPES) expect(isNotificationType(type)).toBe(true);

    /** An unknown type would render as a blank row and escape preference checks. */
    expect(isNotificationType("marketing_blast")).toBe(false);
    expect(isNotificationType("")).toBe(false);
    expect(isNotificationType("SECURITY")).toBe(false);
  });

  it("gives every type the copy Settings and the empty state need", () => {
    // Frontend §4.1 requires the empty state to explain what Atlas sends, and
    // ATL-077 needs a label per control. A type without either is a control
    // nobody can describe.
    for (const type of NOTIFICATION_TYPES) {
      const definition = NOTIFICATION_DEFINITIONS[type];
      expect(definition.settingsLabel.length).toBeGreaterThan(0);
      expect(definition.settingsDescription.length).toBeGreaterThan(0);
    }
  });
});

describe("defaults and configurability (D2)", () => {
  it("enables all five by default", () => {
    for (const type of NOTIFICATION_TYPES) expect(defaultEnabled(type)).toBe(true);
  });

  it("makes security the only non-configurable type", () => {
    expect(isConfigurable("security")).toBe(false);

    for (const type of NOTIFICATION_TYPES.filter((t) => t !== "security")) {
      expect(isConfigurable(type)).toBe(true);
    }
  });

  it("leaves security out of the configurable list by construction", () => {
    /**
     * The list ATL-077 will render. Derived from the definitions rather than
     * written out again, so a type cannot become configurable in one place and
     * not the other.
     */
    expect(CONFIGURABLE_NOTIFICATION_TYPES).not.toContain("security");
    expect([...CONFIGURABLE_NOTIFICATION_TYPES].sort()).toEqual([
      "finding_new",
      "follow_up_due",
      "request_status",
      "system",
    ]);
  });
});

describe("resolveEnabled", () => {
  it("uses the declared default when there is no override (D1)", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(resolveEnabled(type, null)).toBe(defaultEnabled(type));
    }
  });

  it("honours an override for a configurable type", () => {
    for (const type of CONFIGURABLE_NOTIFICATION_TYPES) {
      expect(resolveEnabled(type, false)).toBe(false);
      expect(resolveEnabled(type, true)).toBe(true);
    }
  });

  it("ignores an override for security, even one that says false", () => {
    /**
     * The privacy guarantee, at the layer that can be tested without a database.
     * The migration makes such a row unrepresentable and the service never looks
     * one up; this proves the resolver would refuse to honour it regardless — so
     * the guarantee does not rest on any single one of the three.
     */
    expect(resolveEnabled("security", false)).toBe(true);
    expect(resolveEnabled("security", null)).toBe(true);
  });
});

describe("the templates", () => {
  it("produces a non-empty title and body for every type, with no parameters", () => {
    /**
     * A caller may legitimately pass nothing — a security notice has no service
     * name. A template that returned an empty string would violate the table's
     * `char_length(...) between 1 and ...` check and fail at the insert instead
     * of here.
     */
    for (const type of NOTIFICATION_TYPES) {
      expect(buildNotificationTitle(type).length).toBeGreaterThan(0);
      expect(buildNotificationBody(type).length).toBeGreaterThan(0);
    }
  });

  it("stays inside the column length caps with realistic parameters", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(buildNotificationTitle(type, SAFE).length).toBeLessThanOrEqual(120);
      expect(buildNotificationBody(type, SAFE).length).toBeLessThanOrEqual(400);
    }
  });

  it("names the service when it is given one", () => {
    // The panel row has to be about something. ADR-005 permits service names.
    const title = buildNotificationTitle("follow_up_due", { service: "Acme Media" });
    expect(title).toContain("Acme Media");
  });

  it("falls back to a generic noun rather than breaking a sentence", () => {
    const title = buildNotificationTitle("follow_up_due", {});
    expect(title).not.toContain("undefined");
    expect(title.length).toBeGreaterThan(0);
  });

  it.each(NOTIFICATION_TYPES)(
    "composes hostile parameters into text the ATL-085 scan detects: %s",
    (type: NotificationType) => {
      /**
       * The honest form of this guarantee, and worth being precise about.
       *
       * `service`, `label` and `status` are caller-supplied — a service name comes
       * from the person's own asset record and cannot be pattern-constrained — so a
       * template *can* interpolate a hostile value into prose. `ActivityWriter` has
       * the same exposure and answers it the same way: the enforcement is the scan
       * over the **composed** string, which refuses the write.
       *
       * So what matters here is that a restricted value reaching a template stays
       * *visible to the scanner* rather than being transformed, truncated or
       * encoded into something it no longer matches. If a template ever mangled a
       * value into an unrecognisable form, the service's refusal would silently
       * stop firing and this is the test that would notice.
       *
       * The refusal itself — `INVALID_REQUEST`, nothing stored — is asserted
       * against the real service in `notification-service.integration.test.ts`.
       */
      const composed = `${buildNotificationTitle(type, HOSTILE)} ${buildNotificationBody(type, HOSTILE)}`;

      expect(scrubString(composed).scrubbed).toBe(true);
    },
  );

  it("has no parameter that carries free text (D4)", () => {
    /**
     * The structural half of the guarantee. `NotificationParams` is a closed type
     * whose members are names, statuses and counts — there is no `message`, no
     * `text`, and deliberately no `maskedIdentifier` escape hatch of the kind
     * `ActivityParams` permits, because ADR-005 allows "service names and
     * statuses" and nothing else.
     *
     * Asserted over the keys the hostile fixture enumerates: `Required<...>` makes
     * the compiler force this list to stay complete, so a new member added to the
     * type without being considered here fails to typecheck rather than slipping
     * past.
     */
    expect(Object.keys(HOSTILE).sort()).toEqual([
      "count",
      "days",
      "fromStatus",
      "label",
      "service",
      "severity",
      "status",
      "toStatus",
    ]);
  });

  it("keeps safe parameters unscrubbed, so the guard is not vacuous", () => {
    /**
     * A control. If the scan flagged ordinary copy, the test above would pass for
     * the wrong reason — it would be asserting that nothing ever reaches the
     * scanner rather than that nothing restricted survives it.
     */
    for (const type of NOTIFICATION_TYPES) {
      expect(scrubString(buildNotificationBody(type, SAFE)).scrubbed).toBe(false);
      expect(buildNotificationBody(type, SAFE).length).toBeGreaterThan(0);
    }
  });
});
