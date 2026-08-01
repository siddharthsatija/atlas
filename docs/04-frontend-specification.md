# Atlas Frontend Specification

## 1. Experience objective

Atlas should feel like a calm control center for a person’s digital identity. It must communicate seriousness without looking intimidating, and intelligence without appearing autonomous.

Reference qualities:

- Apple: restraint and polish
- Linear: precision and product density
- Notion: clarity and flexible information structure

Avoid:

- Cybersecurity clichés
- Neon “hacker” visuals
- Fear-based red alerts
- Excessive gradients
- Dense enterprise tables as the default
- AI placed as an unrelated chatbot

## 2. Global layout

### Desktop

- Collapsible left sidebar
- Main content column
- Optional contextual right rail only when it adds value
- Maximum content width: approximately 1440 px
- Comfortable page gutters
- Sticky top bar inside product shell

### Tablet

- Reduced sidebar or icon rail
- Right-rail content moves into main flow
- Cards reflow to two columns

### Mobile

- Sidebar becomes a drawer
- Single-column content
- Primary actions remain reachable
- Tables become cards or horizontally scroll only when unavoidable
- AI opens as a bottom sheet or full-screen panel

## 3. Sidebar

Order:

1. Atlas wordmark
2. Collapse control positioned beside the wordmark at the top
3. Overview
4. Digital Assets
5. Privacy Insights
6. Requests
7. Activity
8. Archive
9. Flexible spacer
10. Settings
11. User profile

Behavior:

- Collapse control must not sit at the bottom.
- Expanded width approximately 240–264 px.
- Collapsed width approximately 72–80 px.
- Preserve selected state.
- Tooltip icon labels when collapsed.
- Keyboard accessible.
- Persist preference per user.
- Mobile uses a drawer, not a compressed rail.

## 4. Top bar

Contains:

- Page title or breadcrumb
- Global search
- Notification control
- Optional “Ask Atlas” trigger
- Profile menu on smaller layouts if sidebar profile is hidden

Search opens a command-style overlay and searches assets, findings, requests, and actions. Search operates only on non-restricted fields (service names, categories, statuses); encrypted values are not searchable by design.

### 4.1 Notifications panel

The notification control shows the unread count (display caps at "9+") and opens a panel:

- Recent notifications, newest first, paginated
- Each item: type icon, title, redacted body, relative time, entity link
- Opening a linked entity marks its notification read; explicit mark-read and mark-all-read actions exist
- Empty state explains what notifications Atlas sends
- Keyboard accessible; panel follows dialog focus rules
- Content never includes personal values or draft text

## 5. Dashboard

### 5.1 Header

- Personalized greeting
- One-sentence status summary
- Primary CTA based on the highest-value available action
- Avoid generic “Welcome back” as the only message

Example:
“Good morning, Maya. You have two privacy actions worth reviewing.”

### 5.2 Metrics row

Exactly four cards (authoritative; resolves the earlier PRD wording that implied a separate "recent changes" card):

- Privacy score
- Digital assets
- Open findings
- Active requests

Cards include:

- Label
- Value
- Context or change (this is where recent-change information lives)
- Optional sparkline
- Click-through behavior
- Accessible description

The privacy score card receives greater emphasis than supporting metrics.

Score card states:

- **Not yet scored:** shown until the user has at least one non-demo asset; explains why and offers the add-asset action.
- **Demo score:** persistent "Demo score" label whenever the score is computed from demo records.
- **Scored:** numeric score with change since previous period and score-coverage note when factors were excluded for missing data.

### 5.3 Digital Assets preview

- Section title and “View all”
- Four to six asset cards
- Service icon
- Name and category
- Summary of known data
- Risk or status indicator
- Last reviewed date
- Contextual hover or focus actions: View, Edit, Archive, Request deletion

Hover actions must also be reachable by keyboard and on touch via an overflow menu.

### 5.4 Privacy Insights

- Prioritized list, not a generic feed
- Each insight shows severity, confidence, source, reason, and action
- One primary action per item
- Dismissal requires an optional reason

### 5.5 AI Assistant placement

The AI Assistant must not float as an unrelated card that competes with core dashboard content.

Preferred behavior:

- A compact “Ask Atlas” card appears after the primary insights or within a contextually relevant area.
- It may expand into a side panel on desktop.
- It surfaces recommended prompts tied to current records.
- It never visually outweighs the dashboard’s user-owned data.
- On asset and finding pages, it becomes contextual to that entity.

### 5.6 Activity

- Compact timeline
- Five recent events
- Type icon
- Human-readable summary
- Relative time with exact timestamp available
- Link to full activity

## 6. Digital Assets list

### Header

- Title
- Explanation
- Add asset button
- Search
- Filter and sort

### Views

- Card grid default
- Compact list optional

### Filters

- Category
- Status
- Risk
- Source
- Last reviewed

### Empty state

Explain what a digital asset is and offer:

- Add first asset
- Use demo data
- Learn how Atlas discovers assets

### Bulk actions

Not required in MVP except archive selection if implementation remains safe and understandable.

## 7. Asset detail

Sections:

1. Identity header
2. Overview
3. Information held
4. Permissions
5. Findings
6. Requests
7. Activity
8. Notes

Header actions:

- Edit
- Archive
- Request correction
- Request deletion
- More menu

Every factual item shows source and last verified time where available.

Sensitive fields are masked. Reveal is explicit and temporary.

## 8. Privacy Insights page

Views:

- Recommended
- All
- Resolved
- Dismissed

Finding card:

- Severity
- Title
- Explanation
- Evidence summary
- Source
- Confidence
- Impacted asset
- Recommended action
- “Ask Atlas” explanation
- Resolve or dismiss

Critical styling is reserved for genuinely critical, verified findings.

## 9. Requests

### Request list

Columns or card fields:

- Service
- Request type
- Status
- Date created
- Follow-up date
- Last activity

### Request detail

- Status timeline
- Recipient
- Included personal fields
- Editable subject and body while draft or ready
- Copy email
- Open email client
- Mark as sent
- Add response note
- Complete or cancel

No control may imply Atlas sent the request unless it actually did.

## 10. Request modal (deletion and correction)

Flow:

### Step 1: Review information

- Service
- Information believed to be held
- Sources and confidence
- Stored personal fields shown as checkboxes, **unchecked by default**, values masked with explicit reveal
- Just-in-time add-field form on first use (nothing is collected at onboarding); saving a field records consent
- Recipient address entered or confirmed by the user, labeled unverified in MVP (verified service directory is Phase 2)
- Warning when evidence is uncertain

### Step 2: Review draft

- Recipient (user-entered, masked in lists)
- Subject
- Editable body
- AI-generated label
- Regenerate with optional tone instructions
- Restore previous draft
- Included fields summarized by key; changing selection returns to Step 1

### Step 3: Take action

- Copy email
- Open email app — disabled with an explanatory message and copy guidance when the draft exceeds about 1,800 characters (mailto length limits truncate silently in common clients)
- Save draft
- Mark sent after user confirms

### Success state

- Clear next step
- Follow-up date suggestion
- Link to request tracker

The modal supports escape, focus trap, keyboard navigation, and draft preservation.

## 11. AI Assistant

Modes:

- Global assistant
- Asset context
- Finding context
- Request drafting

UI:

- Clear statement of what context is being used
- Suggested questions
- Source references
- Confidence and uncertainty language
- Editable output when drafting
- Feedback control
- Clear conversation button

The assistant must not present generated speculation as discovered fact.

## 12. Privacy score experience

### Score card

- Circular or arc indicator
- Numeric score
- Plain-language interpretation
- Change since previous period
- “How this is calculated”

### Detail view

- Factor breakdown with weights (`score-v1`)
- Score coverage: which factors were included and which were excluded for missing data
- Positive and negative contributors
- Change history
- Actions that may improve the score
- Disclaimer that score is a guide, not a guarantee
- Demo scores carry the "Demo score" label throughout the detail view

Charts include text summaries and do not rely on color alone.

## 13. Activity page

- Chronological timeline
- Filters by entity and action
- Date grouping
- Redacted summaries
- Entity links
- Export security events separately only if useful

## 14. Archive

- Archived assets and dismissed items
- Restore action
- Permanent delete action with confirmation
- Explain difference between archiving in Atlas and deletion from an external service

## 15. Settings

### Profile

- Display name
- Locale
- Time zone

### Security

- Authentication methods
- Active sessions
- Sign out all devices

### Privacy and AI

- AI usage disclosure
- Conversation-history preference (off by default; disabling deletes stored conversations)
- Data use choices
- Consent history

### Personal data

- List of stored personal fields, masked by default
- Reveal (explicit, temporary), edit, and delete per field
- Shows when each field was last used in a request
- Explains encryption and that fields are only used in drafts the user approves

### Notifications

- Follow-up reminders
- Security notifications
- Product updates, off by default unless separately consented

### Data

- Export
- Delete demo data
- Delete account

## 16. Authentication

- Calm, minimal sign-in
- Explain why an account is needed
- Email field
- Continue with Google
- Privacy and terms links
- Neutral error messages
- Loading and verification states
- No misleading security claims

## 17. Onboarding

Steps:

1. Introduction and limitations
2. Privacy goal
3. Asset categories
4. Demo data or add an asset
5. Dashboard readiness

Requirements:

- Progress indicator
- Back and skip where safe
- No forced sensitive fields
- Save progress
- Mobile friendly

## 18. Component states

Every interactive component defines:

- Default
- Hover
- Focus
- Active
- Disabled
- Loading
- Error
- Success
- Empty where relevant

Skeletons should resemble final structure. Do not use indefinite spinners for page-level loading.

## 19. Interaction rules

- Hover reveals may enhance but never gate actions.
- Primary action count per card should remain low.
- Destructive actions use confirmation and explicit language.
- Toasts confirm temporary events; durable status appears in the page.
- Modals are reserved for focused, contained tasks.
- Side panels support contextual inspection.
- Preserve form input during recoverable errors.
- Undo is preferred for archive and dismissal.

## 20. Accessibility

- Semantic landmarks
- Logical heading hierarchy
- Keyboard access to every action
- Visible focus indicators
- Minimum target size of 44 by 44 CSS px where practical
- Accessible names for icons
- Focus management for dialogs and route transitions
- Error summaries and field-level errors
- `aria-live` for asynchronous status
- Text alternatives for charts
- Reduced-motion support
- Contrast compliant with WCAG 2.2 AA

## 21. Responsive breakpoints

Suggested starting points:

- Small: below 640 px
- Medium: 640–1023 px
- Large: 1024–1439 px
- Extra large: 1440 px and above

Use content-driven adjustments instead of relying only on device labels.

## 22. Performance

- Use server components for data-heavy read views.
- Lazy-load charts and assistant panel.
- Optimize service icons.
- Avoid large animation libraries for basic transitions.
- Reserve layout space to prevent shift.
- Paginate activity and long lists.

## 23. Content guidelines

Voice:

- Calm
- Direct
- Transparent
- Respectful
- Nonjudgmental

Use:
“Atlas found an address associated with this account.”

Avoid:
“Your address is dangerously exposed!”

Use:
“We could not verify this information recently.”

Avoid:
“This information is definitely current.”

## 24. Analytics events

Track only non-sensitive events:

- onboarding_completed
- asset_created
- finding_opened
- finding_resolved
- deletion_draft_created
- request_marked_sent
- export_requested

Never attach raw personal values, service account identifiers, or draft text.
