# Product Review Checklist

## Scope discipline

- [ ] Work maps to a specific ticket in `docs/05-feature-ticket-list.md`
- [ ] Nothing from PRD §8.2 (out of scope) crept in
- [ ] Any scope addition is documented in `CHANGELOG.md` with rationale
- [ ] No open question from `docs/open-questions.md` was answered by implementation choice

## Honesty of claims

- [ ] No copy implies internet scanning or automatic discovery
- [ ] No copy implies guaranteed deletion from third parties
- [ ] No control implies Atlas sent something it did not send
- [ ] Encryption described as server-side, never end-to-end
- [ ] Score framed as guidance; 100 never implies zero risk
- [ ] Demo records visibly labeled in every surface they appear
- [ ] Unverified data (e.g. MVP request recipients) labeled unverified
- [ ] Uncertainty stated where confidence is low or sources are stale

## Tone and content

- [ ] Calm, direct, transparent, respectful, nonjudgmental
- [ ] No fear-based framing or urgency pressure
- [ ] Explanations teach rather than assume expertise
- [ ] Error messages explain how to recover
- [ ] Empty states explain the concept and offer a next step

## User control

- [ ] Every irreversible or external action requires explicit user review
- [ ] Destructive confirmations use specific language, not "OK"
- [ ] Archive and dismissal offer undo
- [ ] Sensitive fields are optional; nothing sensitive collected at onboarding
- [ ] Personal fields are unchecked by default in request flows
- [ ] Users can see, edit, and delete anything Atlas stores about them

## Journey integrity

- [ ] Onboarding states limitations, not just benefits
- [ ] New accounts get a meaningful first action (not an empty dashboard)
- [ ] Cold-start and demo states are implemented, not just the populated state
- [ ] Request loop is fast on repeat use (stored fields reused, not retyped)
- [ ] Follow-up reminders reach the user (notifications wired)
- [ ] Export and account deletion work end to end

## Metrics and guardrails

- [ ] Analytics events limited to the allowlist in frontend §24
- [ ] No personal values, identifiers, or draft text in any event
- [ ] Change does not increase risk to a guardrail metric (incorrect findings, hallucinations, sensitive logging, unintended sends)
- [ ] Feedback capture available where AI output is shown

## Escalation triggers

Stop and ask the product owner when:

- [ ] Two reasonable interpretations of a requirement exist
- [ ] Implementation requires collecting a new category of personal data
- [ ] A behavior would send, publish, or share data externally
- [ ] The honest version of a claim undermines the feature's value
- [ ] A documented decision appears wrong or self-contradictory
