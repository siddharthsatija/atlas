/**
 * The score history read model (ATL-046).
 *
 * Presentation only. Nothing here writes, and nothing here recomputes a score —
 * ADR-004 forbids the second and ATL-045 owns the first.
 *
 * ## Why the delta compares two snapshots rather than "now" and the last one
 *
 * ATL-045 records a snapshot on *every* change, so the latest snapshot is
 * normally identical to the current score. `current − latest` would therefore be
 * 0 almost always: an arithmetic identity dressed up as news, and a card reading
 * "no change" forever regardless of what the user did.
 *
 * The change worth showing is the one that actually happened — between the two
 * most recent recorded scores. That describes an event, and it is dated, which
 * is why the copy names the day rather than saying "this period": the snapshot
 * model is event-driven, and "previous period" would imply a regular interval
 * the persistence layer does not have.
 *
 * ## Two guards, both about not lying
 *
 *  - **Fewer than two snapshots: no delta.** One recorded score is not a change.
 *  - **Different `score_version`s: no numeric delta.** Subtracting across model
 *    versions would present two different measurements as one movement, and
 *    ADR-004 is explicit that snapshots are never recomputed under a later
 *    version. The entries are still shown; only the subtraction is withheld.
 */

/** One recorded score, as the history renders it. */
export interface ScoreHistoryEntry {
  id: string;
  score: number;
  /** Rendered on every row: entries from different models are not comparable. */
  scoreVersion: string;
  isDemo: boolean;
  /** What triggered the recalculation that recorded it. */
  reason: string;
  recordedAt: string;
}

/**
 * The most recent recorded change, or null when there is not one to describe.
 *
 * `null` is a real answer with two distinct causes, and the UI shows nothing in
 * both: too little history to have a change, or two entries that cannot honestly
 * be subtracted.
 */
export interface ScoreDelta {
  /** The score before the change. */
  from: number;
  /** The score after it — the latest recorded, normally the current score. */
  to: number;
  /** `to − from`. Positive is an improvement. */
  change: number;
  /** When the newer of the two was recorded. */
  recordedAt: string;
}

/**
 * Computes the most recent recorded change from history, newest first.
 *
 * Takes the history in the order the repository returns it (`recorded_at desc,
 * id desc`) rather than sorting again: re-deriving the ordering here would be a
 * second implementation of a decision the index and the repository already make
 * together, and the two would eventually disagree.
 */
export function latestScoreChange(history: readonly ScoreHistoryEntry[]): ScoreDelta | null {
  const [latest, previous] = history;

  // One entry is not a change, and neither is none.
  if (!latest || !previous) return null;

  /**
   * Never subtract across model versions. Only `score-v1` exists today, so this
   * costs nothing now and prevents a wrong number the moment a second version
   * lands — which is precisely when nobody would be looking for it.
   */
  if (latest.scoreVersion !== previous.scoreVersion) return null;

  return {
    from: previous.score,
    to: latest.score,
    change: latest.score - previous.score,
    recordedAt: latest.recordedAt,
  };
}

/**
 * The delta as a sentence: "Changed from 52 to 56 on 12 August".
 *
 * Names the day because the change was an event rather than a period. The date
 * is formatted from the ISO string without a locale argument so it renders
 * identically on the server and the client — a mismatch here is a hydration
 * error, and the score is not worth one.
 */
export function describeScoreChange(delta: ScoreDelta): string {
  const date = new Date(delta.recordedAt);
  const day = Number.isNaN(date.getTime())
    ? delta.recordedAt
    : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;

  return `Changed from ${delta.from} to ${delta.to} on ${day}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** How many entries the detail view shows. Bounded and readable; no paging. */
export const HISTORY_LIMIT = 20;
