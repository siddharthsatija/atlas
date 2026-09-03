/**
 * Onboarding copy (ATL-016, PRD FR-02, frontend §17).
 *
 * Kept in one place because the honesty rules apply to all of it at once: PRD
 * §"Honest framing" and the product skill require Atlas to state plainly what it
 * does *not* do, and a claim is easiest to overstate when the sentence next to it
 * is written months later by someone reading only that screen.
 *
 * ## The limitations are not a disclaimer
 *
 * The acceptance criterion asks for limitations copy that states "no scanning,
 * no guaranteed deletion". They appear on the first step, at the same visual
 * weight as the capabilities, because a limitation shown after the user has
 * already committed is an apology rather than an informed choice. Architecture
 * §11 is equally direct: findings come from the user's own records and "no
 * internet scanning is performed or claimed".
 */

export const ONBOARDING_INTRO = {
  title: "What Atlas does",
  lede: "Atlas helps you see the accounts and data you have spread across the internet, and act on them.",
  /** What the product genuinely does today. Nothing here is aspirational. */
  capabilities: [
    "Keep a private record of the services you have accounts with",
    "Highlight things worth your attention, based on what you have told it",
    "Help you write and track data access and deletion requests",
  ],
} as const;

export const ONBOARDING_LIMITATIONS = {
  title: "What Atlas does not do",
  items: [
    {
      title: "It does not scan the internet for you",
      body: "Atlas works only from what you add. It cannot find accounts you have forgotten, and it will never claim to have searched anywhere on your behalf.",
    },
    {
      title: "It cannot guarantee deletion",
      body: "Atlas helps you ask, and keeps track of what you asked and when. Whether a company complies is up to them and the law where you live.",
    },
    {
      title: "It is not legal advice",
      body: "The templates are a starting point, not advice about your situation.",
    },
  ],
} as const;

export const ONBOARDING_STEP_COPY = {
  privacy_goal: {
    title: "What brings you here?",
    lede: "This shapes what Atlas suggests first. You can change it whenever you like.",
  },
  categories: {
    title: "Where do you have accounts?",
    lede: "Pick as many as apply, or none. This only decides where Atlas starts — nothing is added for you.",
  },
  starting_point: {
    title: "How would you like to begin?",
    lede: "Either way, you are in control of what gets added.",
  },
  /**
   * ATL-209: Identity Profile step.
   *
   * Copy for the step where users add contact details Atlas can use for discovery
   * (e.g. email addresses). The "soft gate" warning below is shown when the user
   * has no email with include_in_discovery = true — but Continue is always
   * available regardless.
   */
  identity_profile: {
    title: "Your identity details",
    lede: "Add the contact details Atlas can use to search for data about you. You decide which ones to include in discovery, and you can change them any time in Settings.",
    softGateWarning:
      "No email address is set up for discovery. Atlas can still search using other details, but an email address is the most effective starting point.",
    consentPreamble:
      "Before saving your details, Atlas needs your permission. Every field is optional and can be removed at any time.",
    noFieldsYet: "No details saved yet.",
    addFieldTitle: "Add a detail",
    addSubmit: "Save detail",
    discoveryToggleLabel: "Use for discovery",
    discoveryToggleHint:
      "When enabled, Atlas uses this detail when searching for accounts and data associated with you.",
    fieldInUseError:
      "This field is currently being used by an active discovery run and cannot be deleted right now. Try again after the run finishes.",
  },
  ready: {
    title: "You are set up",
    lede: "Your dashboard is empty until you add something, which is the honest starting point.",
  },
} as const;

/**
 * The AI-processing consent request (ATL-078, security §10).
 *
 * Phrased as a choice rather than a formality, and unchecked by default. A
 * pre-ticked box would produce a consent record that means nothing, which is
 * worse than no record at all — it would look like agreement in an audit.
 */
export const AI_CONSENT_COPY = {
  label: "Let Atlas use AI to help explain findings and draft requests",
  body: "Your data is sent to an AI provider only when you use one of those features, and only the minimum needed. You can withdraw this at any time in Settings, and Atlas works without it.",
} as const;
