/**
 * Reads the local Supabase mail catcher (ATL-012 E2E support).
 *
 * `supabase start` runs a mail server on port 54324 so outbound mail never
 * leaves the machine (`[inbucket]` in `supabase/config.toml`). The magic link
 * only exists in that mailbox, and it has to be read from there rather than
 * generated another way.
 *
 * ## Why the link cannot be minted directly
 *
 * `admin.generateLink()` looks like the obvious shortcut and does not work here.
 * `@supabase/ssr` uses the **PKCE** flow: the sign-in Server Action stores a code
 * verifier in a cookie, and Supabase records the matching challenge against that
 * specific flow. Verifying a link from a *different* flow returns tokens in the
 * URL fragment instead of the `?code=` our callback exchanges, so the callback
 * would fail with `bad_code_verifier`.
 *
 * Reading the real email is therefore not a workaround — it is the only path
 * that exercises the flow the application actually implements.
 *
 * ## Two API shapes
 *
 * The Supabase CLI has shipped both Inbucket and Mailpit behind the same
 * `[inbucket]` config key and port, and the two expose different APIs. Rather
 * than pin a guess to a CLI version, this probes for whichever is listening.
 */

const MAILBOX_URL = process.env.SUPABASE_INBUCKET_URL ?? "http://127.0.0.1:54324";

/** How long to wait for a message to arrive before failing. */
const DELIVERY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

interface MailpitMessage {
  ID: string;
  To?: { Address?: string }[];
}

interface InbucketMessage {
  id: string;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${MAILBOX_URL}${path}`);
  if (!response.ok) return null;
  return response.json();
}

/** Mailpit: newest message addressed to `email`, with its body. */
async function readViaMailpit(email: string): Promise<string | null> {
  const listed = await getJson("/api/v1/messages");
  if (listed === null || typeof listed !== "object") return null;

  const messages = (listed as { messages?: MailpitMessage[] }).messages;
  if (!Array.isArray(messages)) return null;

  const match = messages.find((message) =>
    (message.To ?? []).some((to) => to.Address?.toLowerCase() === email.toLowerCase()),
  );
  if (!match) return null;

  const body = await getJson(`/api/v1/message/${match.ID}`);
  if (body === null || typeof body !== "object") return null;

  const { HTML, Text } = body as { HTML?: string; Text?: string };
  return `${HTML ?? ""}\n${Text ?? ""}`;
}

/** Inbucket: mailbox is keyed by the local part of the address. */
async function readViaInbucket(email: string): Promise<string | null> {
  const mailbox = email.split("@")[0];
  if (!mailbox) return null;

  const listed = await getJson(`/api/v1/mailbox/${encodeURIComponent(mailbox)}`);
  if (!Array.isArray(listed) || listed.length === 0) return null;

  const newest = listed[listed.length - 1] as InbucketMessage;
  const body = await getJson(
    `/api/v1/mailbox/${encodeURIComponent(mailbox)}/${encodeURIComponent(newest.id)}`,
  );
  if (body === null || typeof body !== "object") return null;

  const { body: content } = body as { body?: { html?: string; text?: string } };
  return `${content?.html ?? ""}\n${content?.text ?? ""}`;
}

/**
 * Extracts the confirmation URL.
 *
 * Matches the Supabase verify endpoint rather than a specific template. Sign-in
 * and sign-up are one operation (ATL-011), so a first-time address receives the
 * signup-confirmation template and a returning one receives the magic-link
 * template — both carry a link through `/auth/v1/verify`.
 *
 * HTML entities are decoded because the anchor href arrives with `&amp;`, which
 * would otherwise corrupt the query string.
 */
function extractVerifyLink(body: string): string | null {
  const match = /https?:\/\/[^\s"'<>]*\/auth\/v1\/verify[^\s"'<>]*/i.exec(body);
  if (!match) return null;

  return match[0].replace(/&amp;/g, "&");
}

/**
 * Polls until the confirmation link for `email` arrives.
 *
 * Waits on the message existing rather than on a fixed delay — no arbitrary
 * sleeps (testing skill). Fails with an actionable message rather than timing
 * out inside Playwright with no explanation.
 */
export async function waitForConfirmationLink(email: string): Promise<string> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  let lastError = "no message arrived";

  while (Date.now() < deadline) {
    try {
      const body = (await readViaMailpit(email)) ?? (await readViaInbucket(email));
      if (body) {
        const link = extractVerifyLink(body);
        if (link) return link;
        lastError = "a message arrived but contained no /auth/v1/verify link";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `No sign-in email for ${email} at ${MAILBOX_URL} within ${DELIVERY_TIMEOUT_MS}ms (${lastError}). ` +
      `The local mail catcher is started by \`pnpm db:start\`; check [inbucket] in supabase/config.toml.`,
  );
}
