/**
 * The notification vocabulary and its definitions (ATL-107, ADR-005).
 *
 * Each of the five types ADR-005 names owns everything that is true about it in
 * one place: the title template, the body template, the parameters those
 * templates may interpolate, whether it is on by default, and whether the person
 * may turn it off.
 *
 * ## Why templates rather than caller-supplied strings
 *
 * A notification body is user-visible free text, and every service that will
 * create one holds restricted data at that moment — the follow-up job knows the
 * recipient address, the request service holds draft text. Letting callers pass a
 * string would make "no personal values, no draft text" (ADR-005, FR-14) a rule
 * each of them has to remember, and the failure would be invisible: an unmasked
 * address in a notification reads perfectly normally.
 *
 * Templates invert that. A caller supplies typed, allowlisted parameters and the
 * writer composes the sentence, so there is **no parameter that accepts free
 * text** and nothing to remember. This is `activity-events.ts`'s design, adopted
 * deliberately rather than reinvented, and the same reasoning that gave the
 * ATL-085 logger no `message` field.
 *
 * ## Why the defaults live here and not in the service or the database
 *
 * A default and a configurability flag describe the *type*, exactly as the
 * template does — they are not facts about any user. Two callers need them: the
 * service, when no override row exists, and Settings → Notifications (ATL-077),
 * which must render an unset toggle in its correct position. Features may not
 * import `src/server` (the ESLint layer boundary), so a default declared inside
 * `NotificationService` would be unreachable from the UI without duplicating it —
 * and a default declared twice eventually disagrees with itself, which is the
 * drift ADR-006 avoids by insisting activity and audit share one call site.
 *
 * Storing them as rows was rejected for a stronger reason: a default written into
 * a table is a *value*, so it must be inserted, which would contradict "absence
 * of a row means the declared default" and would leave accounts created before a
 * default changed permanently disagreeing with accounts created after. And with
 * configurability in data, "security notifications cannot be disabled" would hold
 * only as long as no row said otherwise — a privacy guarantee resting on the
 * absence of a row. Declared here, the service can refuse to write one and the
 * migration can make it unrepresentable.
 *
 * In `lib/` because ATL-077 and ATL-108 both need the labels, the defaults, and
 * the configurability, and the layer boundaries stop components reaching into
 * `src/server`.
 */

/**
 * Parameters a template may interpolate.
 *
 * Every one is a short label, a status from a fixed vocabulary, or a count. There
 * is no free-text parameter, and adding one would defeat the design — which is
 * why the type is closed rather than `Record<string, string>`.
 *
 * Deliberately **narrower than `ActivityParams`**: it has no `maskedIdentifier`.
 * A timeline row saying which address a request went to is useful and ATL-069
 * permits it masked; a notification has no such need, and ADR-005 allows only
 * "service names and statuses". Omitting the parameter is what makes that
 * limit structural instead of advisory.
 */
export interface NotificationParams {
  /** A service or product name, e.g. "Acme". Never a personal value. */
  service?: string;
  /** A short human label for the entity, e.g. "Work email". */
  label?: string;
  /** A status or state name from a fixed vocabulary. */
  status?: string;
  fromStatus?: string;
  toStatus?: string;
  /** A severity or category label. */
  severity?: string;
  /** A count, rendered into the sentence. */
  count?: number;
  /** Whole days, for reminder wording. */
  days?: number;
}

type Template = (params: NotificationParams) => string;

/** Falls back to a generic noun when a label is absent, so a sentence never breaks. */
const named = (params: NotificationParams, fallback: string): string =>
  params.label ?? params.service ?? fallback;

/**
 * One notification type, completely described.
 *
 * `configurable: false` means the type ignores preferences entirely — it is not
 * "defaults to on and can be switched off", it is "there is no switch". Only
 * `security` is declared that way (ADR-005, FR-14, PRD §12).
 */
export interface NotificationDefinition {
  /** Short, specific, and safe to render in a panel row. */
  title: Template;
  /** One sentence of context. Redacted by construction — see the module note. */
  body: Template;
  /** What a person sees in Settings → Notifications (ATL-077). */
  settingsLabel: string;
  /** Why Atlas sends it, for the panel's empty state (frontend §4.1). */
  settingsDescription: string;
  /** D2: every type is on unless the person says otherwise. */
  defaultEnabled: boolean;
  /** False only for `security`, which cannot be turned off. */
  configurable: boolean;
}

/**
 * The vocabulary. Adding an entry here is the only way to add a type.
 *
 * The five values are ADR-005's and architecture §7.14's, unchanged. A sixth
 * would be a product decision, and it would need this file, the check constraint
 * in the migration, and a documented default — which is the point.
 *
 * Titles and bodies are written in the user's voice, present or past tense as the
 * event demands, and never describe the system's internals.
 */
export const NOTIFICATION_DEFINITIONS = {
  /**
   * A follow-up on a sent request has come due (ATL-066, architecture §13).
   *
   * The reason notifications exist at all, per ADR-005: request tracking's value
   * depends on the person being told when to chase.
   */
  follow_up_due: {
    title: (p) => `Time to follow up with ${named(p, "a service")}`,
    body: (p) =>
      p.days === undefined
        ? "Your data request has not had a reply yet. Following up is usually enough."
        : `Your data request has had no reply for ${p.days} days. Following up is usually enough.`,
    settingsLabel: "Follow-up reminders",
    settingsDescription: "When a data request you sent has not had a reply and is due a nudge.",
    defaultEnabled: true,
    configurable: true,
  },

  /** A tracked request changed state (architecture §13). */
  request_status: {
    title: (p) => `Your request to ${named(p, "a service")} changed`,
    body: (p) =>
      p.fromStatus && p.toStatus
        ? `It moved from ${p.fromStatus} to ${p.toStatus}.`
        : "Its status has been updated.",
    settingsLabel: "Request status changes",
    settingsDescription: "When one of your data requests moves to a new stage.",
    defaultEnabled: true,
    configurable: true,
  },

  /** The findings engine opened something new (ADR-001, architecture §11.1). */
  finding_new: {
    title: (p) =>
      p.severity
        ? `New ${p.severity} finding for ${named(p, "a service")}`
        : `New finding for ${named(p, "a service")}`,
    body: (p) =>
      p.count === undefined || p.count <= 1
        ? "Atlas noticed something worth a look."
        : `Atlas noticed ${p.count} things worth a look.`,
    settingsLabel: "New findings",
    settingsDescription: "When Atlas spots something new about a service you track.",
    defaultEnabled: true,
    configurable: true,
  },

  /**
   * Something happened to the account itself (security §12).
   *
   * **Not configurable.** A person cannot opt out of being told about their own
   * account's security, and the service bypasses the preference lookup entirely
   * rather than looking one up and ignoring it.
   */
  security: {
    title: () => "A security change on your account",
    body: (p) =>
      p.status ? `Atlas recorded: ${p.status}.` : "Atlas recorded a change to your account access.",
    settingsLabel: "Security notifications",
    settingsDescription: "Sign-ins, session changes, and account security events. Always on.",
    defaultEnabled: true,
    configurable: false,
  },

  /** Product and account housekeeping that is not a security matter. */
  system: {
    title: () => "An update from Atlas",
    body: (p) => (p.status ? `Atlas recorded: ${p.status}.` : "There is something new to see."),
    settingsLabel: "Product notices",
    settingsDescription: "Occasional notices about Atlas itself.",
    defaultEnabled: true,
    configurable: true,
  },
} as const satisfies Record<string, NotificationDefinition>;

export type NotificationType = keyof typeof NOTIFICATION_DEFINITIONS;

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_DEFINITIONS) as NotificationType[];

const TYPES: ReadonlySet<string> = new Set(NOTIFICATION_TYPES);

/**
 * Whether a string is a known type.
 *
 * Unknown types are *rejected*, never stored: an unrecognised value renders as a
 * blank panel row and is invisible to preference checks, so it fails at the
 * service rather than surfacing later as a gap. `notifications.type` carries a
 * matching check constraint — both exist on purpose, as with
 * `PERSONAL_FIELD_KEYS`: the constraint stops an unrecognised value reaching
 * storage, and the union stops one being written in the first place.
 */
export function isNotificationType(value: string): value is NotificationType {
  return TYPES.has(value);
}

/** The types a person may switch off. `security` is absent by construction. */
export const CONFIGURABLE_NOTIFICATION_TYPES: readonly NotificationType[] =
  NOTIFICATION_TYPES.filter((type) => NOTIFICATION_DEFINITIONS[type].configurable);

/** Whether this type answers to preferences at all. */
export function isConfigurable(type: NotificationType): boolean {
  return NOTIFICATION_DEFINITIONS[type].configurable;
}

/**
 * The declared default for a type, used when no override row exists (D1).
 *
 * Non-configurable types report `true` and mean it unconditionally — there is no
 * row that could change the answer.
 */
export function defaultEnabled(type: NotificationType): boolean {
  return NOTIFICATION_DEFINITIONS[type].defaultEnabled;
}

/**
 * Resolves the effective preference: an override row if there is one, the
 * declared default otherwise.
 *
 * In `lib/` and pure, so the service and the Settings UI (ATL-077) share one
 * implementation rather than each deciding what an absent row means. A
 * non-configurable type short-circuits *before* the override is consulted, so a
 * row that should not exist cannot change the outcome even if one somehow does —
 * the check constraint is the first gate, and this is the second.
 */
export function resolveEnabled(type: NotificationType, override: boolean | null): boolean {
  if (!isConfigurable(type)) return NOTIFICATION_DEFINITIONS[type].defaultEnabled;
  return override ?? NOTIFICATION_DEFINITIONS[type].defaultEnabled;
}

/** Builds the title for one notification. */
export function buildNotificationTitle(
  type: NotificationType,
  params: NotificationParams = {},
): string {
  return NOTIFICATION_DEFINITIONS[type].title(params);
}

/** Builds the body for one notification. */
export function buildNotificationBody(
  type: NotificationType,
  params: NotificationParams = {},
): string {
  return NOTIFICATION_DEFINITIONS[type].body(params);
}
