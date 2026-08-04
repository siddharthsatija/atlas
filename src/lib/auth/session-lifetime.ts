/**
 * Session lifetime policy (ATL-013).
 *
 * Security §5 requires absolute and idle session lifetimes to be "defined and
 * enforced". Supabase provides neither: it rotates refresh tokens and expires
 * access tokens (`jwt_expiry`, 1 hour), but a refresh token stays valid
 * indefinitely while it keeps being used. So an unattended browser stays signed in
 * forever unless the application enforces its own limits — which is what the
 * ticket means by "custom middleware where the provider lacks native support".
 *
 * Pure and clock-injected so expiry can be simulated exactly rather than waited
 * for.
 */

/**
 * **Idle lifetime: 14 days.**
 *
 * Time since the last request. This is the limit that protects a shared or
 * borrowed device: a session someone walked away from stops working. Chosen to
 * sit well beyond a normal usage gap — Atlas is a periodic-use product, not a
 * daily one, and a privacy tool that logs people out every week trains them to
 * treat sign-in as noise.
 */
export const IDLE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * **Absolute lifetime: 90 days.**
 *
 * Time since the session was established, regardless of activity. Caps the value
 * of a stolen refresh token: continuous use can no longer extend a session
 * indefinitely, so a compromised token has a bounded life even if the theft is
 * never noticed. Aligned with the 90-day retention horizon used elsewhere in the
 * product (audit events, notifications).
 */
export const ABSOLUTE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** Marks when the session began. Server-written, `HttpOnly`. */
export const SESSION_STARTED_COOKIE = "atlas.session.started";

/** Marks the last observed request. Server-written, `HttpOnly`. */
export const SESSION_SEEN_COOKIE = "atlas.session.seen";

export type SessionLifetimeStatus =
  | "active"
  /** Idle limit reached — no request within `IDLE_LIFETIME_MS`. */
  | "expired_idle"
  /** Absolute limit reached — session older than `ABSOLUTE_LIFETIME_MS`. */
  | "expired_absolute";

export interface SessionMarkers {
  startedAt: number | null;
  lastSeenAt: number | null;
}

export interface SessionLifetimeDecision {
  status: SessionLifetimeStatus;
  /** Markers to write back. Absent when nothing needs updating. */
  markers?: { startedAt: number; lastSeenAt: number };
}

/**
 * Parses a marker cookie.
 *
 * Anything that is not a plain positive integer resolves to `null`, which the
 * evaluator treats as "unknown" rather than "zero" — a malformed value must not
 * read as an epoch timestamp and expire every session on the spot.
 */
export function parseMarker(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function serializeMarker(timestamp: number): string {
  return String(Math.floor(timestamp));
}

/**
 * Decides whether a session may continue, and what markers to write.
 *
 * Absolute is checked before idle so a session past both limits reports the more
 * fundamental reason.
 *
 * **Missing markers start the clocks rather than expiring the session.** A
 * session established before this policy existed, or one whose markers were
 * dropped, is adopted at the current time. The alternative — treating unknown as
 * expired — would sign out every existing user on deploy for no security benefit,
 * since the session token itself is still validated by Supabase on every request.
 *
 * The trade this accepts is stated plainly: because the markers live in cookies,
 * a client that deliberately strips them restarts its own absolute clock. That
 * bounds what these limits defend against — they protect an unattended or stolen
 * *browser*, which is the realistic threat, not a user determined to extend their
 * own session. Closing it needs server-side session records, which arrive with
 * ATL-075's active-session list; the cookie shape here is deliberately small so
 * that swap is contained.
 */
export function evaluateSessionLifetime(
  markers: SessionMarkers,
  now: number,
): SessionLifetimeDecision {
  const { startedAt, lastSeenAt } = markers;

  // Unknown or future-dated markers are adopted at `now`. A future timestamp is
  // either clock skew or tampering; either way it must not extend a session.
  const started = startedAt !== null && startedAt <= now ? startedAt : now;
  const lastSeen = lastSeenAt !== null && lastSeenAt <= now ? lastSeenAt : now;

  if (now - started >= ABSOLUTE_LIFETIME_MS) {
    return { status: "expired_absolute" };
  }

  if (now - lastSeen >= IDLE_LIFETIME_MS) {
    return { status: "expired_idle" };
  }

  return { status: "active", markers: { startedAt: started, lastSeenAt: now } };
}

/** Cookie attributes for both markers. */
export function sessionMarkerCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecure,
    path: "/",
    // Never outlives the absolute limit it enforces.
    maxAge: Math.floor(ABSOLUTE_LIFETIME_MS / 1000),
  };
}
