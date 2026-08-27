# Atlas Product Requirements Document

## 1. Document control

| Field         | Value                                          |
| ------------- | ---------------------------------------------- |
| Product       | Atlas                                          |
| Version       | 1.0                                            |
| Status        | Approved for MVP implementation                |
| Audience      | Product, design, engineering, security, AI, QA |
| Primary owner | Founding team                                  |
| Tagline       | Map your digital identity.                     |

## 2. Executive summary

Atlas is a personal digital identity platform that gives individuals a consolidated view of the accounts, personal information, permissions, and digital traces associated with them. It helps users understand what exists, evaluate risk, decide what to keep, edit, archive, or remove, and track the actions they take.

Atlas is not positioned as a password manager, identity-theft insurer, or fear-driven privacy scanner. Its primary promise is visibility and agency. The experience should feel calm, premium, transparent, and user-controlled.

Atlas is discovery-first. Users build an Identity Profile — the personal fields they explicitly provide to Atlas — and Atlas uses those fields to search approved evidence sources for digital relationships they may not have recalled or recognised. Discovery coverage is bounded: Atlas searches the evidence sources and providers it has access to (breach corpora and username-discovery providers at MVP, with connected sources as a separately gated future capability) and builds the best supported picture it can from retrievable evidence. No relationship is proposed without evidence, and every proposed candidate requires the user's confirmation before it becomes part of their verified digital identity.

The MVP validates whether users value a discovery-first digital identity map and whether guided privacy actions lead to repeat engagement. Manual asset creation remains available as a fallback for services the user knows about that Atlas did not surface.

## 3. Problem statement

People create accounts, grant permissions, share personal information, and leave behavioral traces across many services. They typically cannot answer:

- Which services still hold information about me?
- What information does each service have?
- Which permissions are excessive or outdated?
- What should I address first?
- How do I request deletion or correction?
- Did a previous request succeed?
- Is my digital exposure improving?

Existing tools often solve only one part of the problem, such as passwords, breach alerts, data broker removal, or identity monitoring. Users need one understandable control layer for their broader digital identity.

## 4. Vision and mission

**Vision:** Become the operating system for personal digital identity.

**Mission:** Give every person complete visibility and meaningful control over their digital presence.

## 5. Product principles

### 5.1 User ownership

Users control what Atlas stores, analyzes, exports, and deletes. Atlas must not create artificial lock-in.

### 5.2 Calm clarity

Risk is explained with evidence and context. Avoid alarming language, dark patterns, or exaggerated certainty.

### 5.3 Human approval

AI may summarize, recommend, and draft. The user must review any external communication or irreversible action.

### 5.4 Source transparency

Findings identify their source, last verification time, confidence, and limitations.

### 5.5 Data minimization

Collect only what is required for the user-requested function. Sensitive fields should be optional wherever possible.

### 5.6 Visible progress

Users should see completed actions, remaining work, and changes in their privacy score over time.

### 5.7 Light-mode-first design

Atlas's visual design uses a light palette as its baseline. Dark mode is supported through system preference or explicit user toggle and must be a fully considered experience, but product and design documentation should not present Atlas as a dark-mode-first product. Marketing, onboarding, and default presentation are light-mode.

## 6. Target users

### 6.1 Primary persona: Privacy-aware professional

Uses many digital services, values convenience, and wants control without becoming a privacy expert.

Needs:

- A quick picture of exposure
- Prioritized actions
- Clear explanations
- Efficient request drafting and tracking

### 6.2 Secondary persona: Student or early-career user

Has accumulated accounts across school, work, social, shopping, and AI tools.

Needs:

- Education without judgment
- Low-effort cleanup
- Clear distinction between essential and obsolete accounts

### 6.3 Secondary persona: AI power user

Frequently shares information with AI and productivity services and wants to understand retention, permissions, and account footprint.

Needs:

- Service-specific insight
- Permission visibility
- Practical controls
- Confidence that Atlas itself handles data responsibly

## 7. Jobs to be done

- When I want to understand my online presence, help me see the services and information connected to me in one place.
- When Atlas proposes a service I may be connected to, show me the evidence and let me decide whether it is mine.
- When I see a privacy issue, explain why it matters and what I can do.
- When I decide to remove information, help me prepare and track the request.
- When I return later, show whether my situation improved.
- When I lose trust in Atlas, let me export and permanently delete my data.

## 8. MVP scope

### 8.1 In scope

1. Account creation, authentication, and onboarding
2. Identity Profile: a user-provided vault of personal fields (email addresses, name, phone, location, usernames and handles) stored encrypted at rest; the foundation for both discovery inputs and request-drafting material; every field optional and individually revocable
3. Discovery pipeline: bounded outbound search of approved evidence sources using identity fields the user has explicitly enabled for discovery; surfaces evidence records, exposure notices, and proposed candidate digital relationships
4. Candidate adjudication: user reviews each proposed digital relationship with supporting evidence and chooses Confirm, Reject, Dismiss, or Not sure; confirmed candidates become confirmed digital assets; rejected candidates are durably suppressed; dismissed and uncertain candidates may resurface with additional evidence or guidance
5. Dashboard with a consolidated view of the user's verified digital identity: privacy score, confirmed digital assets, open findings, active requests, insights, assistant, and activity
6. Privacy findings generated by the deterministic rule engine (architecture §11.1, ADR-001) over the user's confirmed digital assets, permission, category, and request records; no finding is generated from unconfirmed discovery evidence
7. Explainable privacy score and history
8. AI-assisted explanation and drafting of deletion and correction requests
9. User-managed personal fields for request drafting; fields shared between the Identity Profile and the request-drafting vault; additional sensitive fields collected just-in-time during draft flows
10. User editing, copying, and marking requests as sent
11. Request lifecycle tracking with in-app follow-up notifications
12. Activity timeline
13. In-app notifications with unread state
14. Search, filtering, sorting, and asset detail views
15. Profile, privacy, notification, personal-data, discovery-consent, and data settings
16. Manual addition of digital assets as a fallback for services the user knows about that Atlas did not discover
17. Seeded demonstration dataset for first-use experience
18. Data export and account deletion
19. Responsive desktop and mobile experience
20. Accessibility target of WCAG 2.2 AA

### 8.2 Out of scope for MVP

- Complete or guaranteed discovery of all digital accounts and personal information across the internet — Atlas searches approved evidence sources only and does not claim comprehensive coverage
- Automated deletion from third-party services
- Sending messages without explicit user approval
- Password storage or password autofill
- Credit monitoring or identity-theft insurance
- Legal representation
- Continuous dark-web monitoring
- Family or enterprise accounts
- Browser extension
- Native mobile applications
- Marketplace of third-party privacy services

## 9. Primary user journeys

### 9.1 First-time onboarding

1. User creates an account.
2. Atlas explains what it does and does not do: what discovery means, which evidence sources it searches, what information leaves Atlas for each provider type, and that coverage is bounded by available providers.
3. User chooses a privacy goal.
4. User builds their Identity Profile: provides at minimum one email address; optionally adds name, phone, location, and usernames or handles. No field beyond the minimum for a chosen action is required.
5. User reviews which identity fields to enable for discovery and what each approved provider will receive for those fields.
6. User grants discovery consent for the relevant provider types. Atlas presents appropriate disclosure notices based on what each provider type transmits: for breach-corpus lookup (HIBP), the consent notice explains that a partial hash derived from the email address — not the email itself — is transmitted; for identifying providers (username/handle lookup), a first-disclosure acknowledgment shows the exact handle and the named provider before that handle is transmitted to that provider for the first time; broker-search queries are separately addressed at the time the user initiates a broker lookup and are not part of the initial discovery run.
7. Atlas runs initial discovery against approved evidence sources using the enabled fields.
8. Atlas presents discovery results: exposure evidence surfaced directly from discovery records (for example, aggregator-attributed breach appearances) where no account candidate is implied; and proposed candidates where ownership requires adjudication.
9. Candidate adjudication is optional at this stage. The user may review and adjudicate some or all candidates now, or defer all of them and proceed directly to the Dashboard. Deferred and unconfirmed candidates are not part of the user's confirmed digital identity and cannot produce findings or enter the score pipeline until confirmed. For candidates the user does adjudicate: selecting Confirm promotes the candidate to a confirmed digital asset (the findings pipeline may then run against it); Reject permanently suppresses the candidate and stores a rejection fingerprint; Dismiss defers without suppression; Not sure signals genuine uncertainty and keeps the candidate available for re-review.
10. Atlas builds the initial Dashboard from confirmed digital assets, surfaced evidence, and any findings generated from confirmed assets. Deferred candidates remain available in the Discover surface.
11. User sees a recommended first action.

Demo mode is available for users who prefer not to provide identity information or grant discovery consent at onboarding. Manual asset addition is a fallback available throughout the product for discovery misses — it is not an alternative to the discovery path at onboarding.

### 9.2 Discovery and candidate adjudication

1. Atlas runs a discovery scan (initial at onboarding; subsequent scans scheduled or user-initiated).
2. Atlas presents new evidence and proposed candidate digital relationships.
3. For each candidate: user sees the service name, evidence source, confidence level, and the data categories or signals involved.
4. User selects an adjudication action:
   - **Confirm** — candidate is promoted to a confirmed digital asset; findings pipeline may run against it.
   - **Reject** — candidate is permanently suppressed; a rejection fingerprint is stored; the candidate will not resurface for this user.
   - **Dismiss** — deliberate deferral; candidate may resurface in future scans with lower urgency; no suppression fingerprint is stored.
   - **Not sure** — genuine uncertainty about ownership; candidate remains available for re-review; Atlas may surface additional evidence or guidance; elevated not-sure rates for a provider are a provider-quality signal.
5. For exposure evidence that does not create an account candidate (for example, a breach record attributed to a data aggregator rather than a specific service), Atlas surfaces it directly in the discovery experience without requiring adjudication.
6. After adjudication, the Dashboard and privacy score reflect newly confirmed assets and any generated findings.

### 9.3 Review digital identity

1. User opens Dashboard.
2. User reviews privacy score and changes.
3. User scans confirmed digital assets and recent findings.
4. User opens an asset detail page.
5. User reviews stored data, permissions, findings, evidence basis, and activity.
6. User keeps, edits, archives, de-confirms (discovery-origin assets only), or starts a removal workflow.

### 9.4 Create a deletion request

1. User selects “Request deletion.”
2. Atlas displays the information believed to be held by the service, plus the user's stored personal fields (or prompts to add them just-in-time on first use).
3. User approves which fields to include (unchecked by default) and enters or confirms the recipient address.
4. AI generates an editable request draft using only the approved fields.
5. User reviews and edits the draft.
6. User copies the draft or opens their email client.
7. User marks the request as sent.
8. Atlas begins status tracking and in-app follow-up reminders.

### 9.5 Resolve a finding

1. User opens a finding.
2. Atlas explains source, evidence, confidence, and impact.
3. User selects a recommended action.
4. User completes or dismisses the action.
5. Atlas records the decision and updates the score when appropriate.

## 10. Functional requirements

### FR-01 Authentication

- Support email magic link or passwordless sign-in.
- Support Google OAuth as an optional convenience.
- Protect authenticated routes.
- Allow session revocation and sign-out from all devices.

### FR-02 Onboarding

- Explain Atlas’s purpose, limitations, and data practices, including what outbound discovery requests leave Atlas for each provider type and that discovery coverage is bounded by available providers.
- Guide users through building an initial Identity Profile; every field beyond the minimum required for a chosen action is optional.
- Present discovery-enabled field selection and make clear the distinction between Identity Profile fields (stored by the user) and fields authorised for discovery (a subset the user explicitly enables, subject to provider eligibility and consent).
- Obtain discovery consent before any provider runs; present each consent type and its implications in plain language.
- Present disclosure notices appropriate to each provider type. Three cases are distinct: (a) for hashed-query providers (HIBP breach corpus), inform the user that partial hash material derived from their email address — not the plaintext email — is transmitted; this type is not subject to the per-field first-disclosure acknowledgment requirement; (b) for identifying providers (username/handle lookup), display a first-disclosure acknowledgment before the first transmission of each identity field to each named provider; cancelling the notice blocks that invocation only and does not modify the stored field, the `include_in_discovery` preference, or standing consent; a new acknowledgment is required if the provider's disclosure contract changes materially; (c) broker-search queries require a per-query confirmation immediately before each individual search; broker search is not governed by standing discovery consent and is not part of the initial discovery run.
- Capture user goals without requiring sensitive personal data.
- Allow skipping optional steps; demo mode is available as an alternative for users who prefer not to provide identity information or grant discovery consent at onboarding.
- Provide a populated demo mode.

### FR-03 Dashboard

- Show a four-card metrics row: privacy score, total assets, open findings, active requests. Recent-change context appears inside each card (change indicator) and in the activity preview — there is no separate "recent changes" card.
- Show asset previews grouped by category.
- Show prioritized insights.
- Show contextual AI assistance.
- Show recent activity.
- Avoid presenting unsupported claims as live findings.

### FR-04 Digital assets

Each asset includes:

- Service name
- Category
- URL or domain
- Account identifier masked by default
- Status
- Data categories
- Permissions
- Findings
- Last reviewed date
- User notes
- Source and confidence

Assets may originate from three sources:

- **Discovery** — a candidate confirmed by the user through the adjudication flow; carries a reference to the originating candidate and evidence; may be de-confirmed (returning the candidate to rejected status and durably suppressing it).
- **Manual addition** — a user-supplied service not surfaced by discovery; has no candidate reference; de-confirmation is not available on manually-added assets.
- **Demo** — seeded demonstration records, clearly labelled, never mixed with real data in score computation, and removable in one action.

The asset detail view surfaces the origin, evidence basis, and source confidence. Users can create (manual fallback), edit, archive, restore, and delete assets.

### FR-05 Privacy findings

Findings are produced by the deterministic rule engine (architecture §11.1, ADR-001) from the user's confirmed digital assets, permission, category, and request records. Discovery evidence contributes to findings only after the user confirms the underlying candidate (confirmation-first; ADR-007 §7). No finding is generated from unconfirmed discovery evidence. For exposure evidence that does not create an account candidate (such as a breach attributed to a data aggregator), Atlas surfaces it as an evidence notice in the discovery experience rather than as a finding against a confirmed asset. Findings auto-resolve when their condition clears.

Each finding includes:

- Title
- Description
- Severity
- Confidence
- Source
- Evidence summary
- Recommended action
- Status
- Created and resolved timestamps

### FR-06 Privacy score

- Range from 0 to 100, computed by the versioned `score-v1` model (architecture §11.2, ADR-004).
- Explain score factors, weights, and coverage (which factors had data).
- Show "Not yet scored" until the user has at least one non-demo asset.
- Label demo-based scores "Demo score"; never mix demo and real records in one calculation.
- Never imply that 100 means zero risk.
- Update only from auditable events.
- Display history and factor-level changes.

### FR-07 AI assistant

- Answer questions using the user’s Atlas data and approved product knowledge.
- Explain findings in plain language.
- Recommend next actions.
- Draft deletion or correction requests.
- Clearly indicate uncertainty.
- Never send external communications or make irreversible changes.

### FR-08 Data requests (deletion and correction)

- Support both deletion and correction request types.
- Generate an editable draft using only personal fields the user approved in the current flow.
- Personal fields come from the user's encrypted personal-fields vault (FR-13); they are unchecked by default and approval is per request.
- The recipient address is entered or confirmed by the user in MVP (no verified service directory until Phase 2) and is clearly marked unverified.
- Show which personal fields are included; allow any field to be excluded.
- Support copy, mail-client handoff, save draft, and mark as sent. When the draft exceeds safe mailto length (about 1,800 characters), guide the user to the copy path.
- Track statuses: draft, ready, sent, awaiting response, follow-up due, completed, rejected, canceled.
- Preserve an audit trail.

### FR-09 Activity timeline

- Show user actions and system-generated events.
- Support filtering.
- Avoid exposing full sensitive values in summaries.

### FR-10 Search and filters

Search assets, findings, and requests by service, category, status, and severity.

### FR-11 Settings

- Profile
- Authentication and sessions
- Notifications (per-type preferences; security notices cannot be disabled)
- AI preferences (including conversation-history opt-in)
- Identity Profile (view, edit, and delete identity fields; manage `include_in_discovery` preferences per field — see FR-15)
- Discovery (view active discovery consents; withdraw consent per provider class; view first-disclosure acknowledgment history — see FR-16)
- Personal data (view, edit, delete stored personal fields used for request drafting — masked by default; see FR-13)
- Data export
- Account deletion
- Consent history

### FR-13 Personal fields (request-drafting vault)

- Store the optional sensitive fields used to populate deletion and correction request drafts (e.g., postal address, phone number) in an encrypted vault (ADR-002). These fields are distinct from the Identity Profile (FR-15), which is collected at onboarding to enable discovery.
- Collect just-in-time during the first draft flow, not at onboarding. When the user initiates a deletion or correction request, Atlas prompts for any vault fields that are not yet stored.
- Every field is optional, masked by default, individually deletable, and consent-gated on first save.
- Fields are used only in drafts the user explicitly approves them for in the current request flow.

### FR-14 Notifications

- In-app notifications for follow-up reminders, request status changes, new findings, and security events (ADR-005).
- Unread count in the top bar; mark read and mark all read.
- Per-type preferences; security notifications cannot be disabled.
- No personal values or draft text in notification content.

### FR-15 Identity Profile

The Identity Profile is the user-managed set of identity signals Atlas uses as discovery inputs. It is collected at onboarding and managed throughout the session.

- Identity Profile fields: email address(es), name, phone number, location (city/region), usernames and social handles.
- Each field is optional, individually deletable, and masked by default in the UI.
- Each field carries an `include_in_discovery` preference that the user controls. This preference gates whether the field is offered to eligible discovery providers; it is separate from consent (which is per provider class) and from system eligibility (which is determined by the dispatch contract, ADR-008 §4).
- First-disclosure acknowledgment is required before any identity field is transmitted to a discovery provider. Atlas surfaces this acknowledgment per provider class and records it.
- Identity Profile fields used in discovery are distinct from request-drafting fields in FR-13. A user may include an email in their Identity Profile for discovery without also using it in a deletion-request draft, and vice versa.
- Users may view, edit, and delete Identity Profile fields at any time from Settings > Identity Profile.

### FR-16 Discovery and candidate adjudication

Discovery is the process by which Atlas searches approved evidence sources using the user's Identity Profile fields to surface digital relationships the user may not have recalled or recognised. Candidate adjudication is the step at which the user evaluates proposed candidates.

- Atlas runs discovery after the user has built their Identity Profile and granted consent for at least one provider class. Discovery may be re-run as the Identity Profile changes or as new provider classes are enabled.
- Discovery results are presented as a structured list of candidates (proposed associations between the user and a service) and, where applicable, aggregator-sourced exposure evidence (e.g., breach appearances not tied to a specific account — see ADR-007 §12). Exposure evidence surfaces directly in the discovery results without creating an account candidate.
- Discovery coverage is bounded and honestly represented. Atlas searches the evidence sources and providers it has access to and builds the best-supported picture it can from retrievable evidence. Atlas never claims comprehensive or guaranteed coverage of the user's full digital footprint.
- Each candidate carries evidence: source, provider class, confidence, and the evidence summary on which the proposal is based.
- The user adjudicates each candidate using one of four outcomes:
  - **Confirm** — the user recognises this as their account. The candidate becomes a confirmed digital asset; the findings pipeline may run.
  - **Reject** — the user identifies this as not their account. The candidate is rejected; a durable suppression fingerprint is recorded so the same association is not re-proposed.
  - **Dismiss** — the user deliberately defers the candidate. Non-terminal. The candidate resurfaces with lower urgency.
  - **Not sure** — the user is genuinely uncertain. Non-terminal. The candidate remains available for additional evidence or guidance and serves as a provider-quality signal.
- No finding is generated from an unconfirmed candidate. The findings pipeline runs only over confirmed digital assets (`privacy_findings.asset_id NOT NULL`).
- Discovery-origin assets display their origin and supporting evidence. Users may de-confirm a discovery-origin asset, reverting it to candidate status and removing associated findings.
- Discovery consent status and first-disclosure acknowledgment history are visible in Settings > Discovery (FR-11).

### FR-12 Export and deletion

- Export user data in a readable machine-friendly format.
- Require reauthentication for account deletion.
- Explain deletion timing and exceptions.
- Remove or irreversibly anonymize user data according to policy.

## 11. Non-functional requirements

### NFR-01 Performance

- Core dashboard should become usable within 2.5 seconds on a typical broadband connection after authentication.
- Interaction feedback should appear within 100 ms.
- Long-running AI operations must show progress and support cancellation.

### NFR-02 Reliability

- Graceful degradation if AI is unavailable.
- Idempotent request-status updates.
- No loss of user-authored drafts.

### NFR-03 Accessibility

- Meet WCAG 2.2 AA.
- Complete keyboard navigation.
- Visible focus states.
- Screen-reader names for icon controls.
- Text alternatives for charts.
- Reduced-motion support.

### NFR-04 Security

Security requirements are defined in `03-security-and-access.md` and override implementation convenience.

### NFR-05 Privacy

- No advertising use of personal data.
- No sale of user data.
- No training external models on user data without explicit opt-in.
- No sensitive data in analytics or logs.

### NFR-06 Explainability

Every automated finding and score change must be traceable to a rule, source, or model output.

## 12. Information architecture

Primary navigation:

- Overview (Dashboard)
- Discover (Identity Profile, discovery run status, candidate adjudication, exposure evidence)
- Digital Assets
- Privacy Insights
- Requests
- Activity
- Archive
- Settings

The Discover section surfaces the discovery-first workflow: Identity Profile management, discovery progress, candidate review, and exposure evidence. Confirmed candidates move to Digital Assets. The exact navigation label and surface organisation are design decisions; this IA records the required capability grouping, not the final screen structure.

Global utilities:

- Search
- Notifications
- AI Assistant
- Profile menu
- Help

## 13. Success metrics

### Activation

- Percentage completing onboarding
- Percentage adding or reviewing at least one asset
- Percentage completing one meaningful action in the first session

### Engagement

- Weekly active users
- Assets reviewed per active user
- Findings opened
- Return rate after seven and thirty days

### Action

- Deletion drafts created
- Drafts copied or marked sent
- Findings resolved
- Follow-ups completed

### Trust

- Explanation helpfulness
- AI draft acceptance or edit rate
- Export completion
- Account deletion completion
- Support contacts related to confusing data use

### Guardrail metrics

- Incorrect finding reports
- AI hallucination reports
- Security incidents
- Sensitive logging incidents
- Unintended external sends, target: zero

## 14. MVP launch criteria

- All P0 tickets complete
- Security review complete
- RLS tests passing
- No critical or high-severity unresolved vulnerabilities
- Accessibility audit completed
- Export and deletion tested
- AI unavailable state tested
- Legal and privacy copy reviewed
- Demo claims clearly labeled
- Production monitoring enabled

## 15. Future roadmap

The roadmap is organised by capability, not by provider selection. Provider choices within each capability (which breach corpus, which username-enumeration service, which broker network) are implementation decisions and do not change the product capability milestone.

### Phase 2

- Broader provider coverage: additional approved breach, exposure, and username-discovery providers within the existing bounded-discovery model.
- Service directory with verified deletion instructions: per-service request addresses and known privacy-contact channels, reducing reliance on user-entered recipient addresses.
- Connected sources (gated): OAuth-based account connectors, available only after the applicable compliance and security prerequisites (CASA or equivalent) are satisfied. Connected sources are a separately gated capability, not a default Phase 2 deliverable.
- Follow-up reminders via email: post-launch fast-follow on in-app notifications (ADR-005, OQ-07).
- Richer score personalisation.

### Phase 3

- Email receipt and account discovery: opt-in email parsing to surface account-creation and service-communication evidence; requires explicit consent and a separate compliance review. Account and service-relationship evidence from connected email enters the same confirmation-first candidate lifecycle (ADR-007 §7) — evidence produces proposed candidates which the user confirms or rejects; no asset is created from unconfirmed discovery evidence.
- Marketing and subscription relationship discovery: surfacing recurring marketing and subscription senders from connected email for user review; part of the connected-source capability and subject to the same confirmation-first lifecycle and compliance prerequisites as account discovery.
- Broker-search capabilities: discovery against data-broker and people-search sources, subject to the disclosure boundaries approved for that provider class.
- Automated evidence refresh.
- Browser extension.
- Native mobile apps.
- Family plans.

### Phase 4

- User-controlled identity agent.
- Permission negotiation.
- Portable consent and data-sharing profiles.
- Enterprise-sponsored consumer privacy benefits.

## 16. Open decisions

Tracked with owners and recommendations in `docs/open-questions.md`. Summary of active decisions:

- Final service providers for authentication, email, analytics, error monitoring, and rate-limit store (OQ-09)
- Score weight tuning after user testing; v1 weights set in ADR-004; changes require a new score version (OQ-08)
- Initial supported request jurisdictions and template variants: GDPR, CCPA, or generic (OQ-02)
- Whether the MVP launches to EU/EEA users; drives data-residency, transfer mechanism, and processor DPA work (OQ-01)
- Whether request emails are sent through Atlas in a later phase; MVP is copy/mailto only (OQ-05)
- Timing of email delivery for notifications; in-app only at MVP (OQ-07)
- Audit retention window by jurisdiction; 90-day default pending legal review (OQ-06)
- Pricing and monetisation model; not an MVP blocker but affects Phase 2 scope (OQ-10)
- What makes a discovery finding "verified" — partially resolved (OQ-11): ADR-007 §10 defines the verification model (claim-level, computed at read time from `evidence_refs_json`; not stored); whether verified status gates the critical-emphasis styling in the design system is still an open product and design call; see `docs/open-questions.md`

Resolved decisions (no longer open): demo mode is post-signup only (OQ-03); score fairness for disputed findings uses the correction path, not reduced-weight dismissals (OQ-04).
