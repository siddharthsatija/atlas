/**
 * The write-on-change fingerprint (ATL-045, ADR-004, architecture §11.2).
 *
 * ADR-004: "a snapshot is written only when the score or factor breakdown
 * changes". This module decides what "changes" means, and the decision is
 * narrower than it looks.
 *
 * ## No float ever enters the comparison
 *
 * A factor's `value` and `normalisedWeight` are floats — 71.42857142857143 and
 * the like. Comparing them would make two calculations over *identical* records
 * differ on floating-point noise and write a snapshot on every mutation,
 * defeating the rule this module exists to implement. Rounding them to N places
 * to dodge that would be a tolerance, and tolerances are what this project has
 * repeatedly refused to add.
 *
 * So the fingerprint compares only exact values:
 *
 *   - `score` — an integer, already rounded once
 *   - `scoreVersion` — two snapshots are comparable only under one version
 *   - `isDemo` — a demo score and a real score are never the same score
 *   - per factor: `id`, `excluded`, and `inputs`
 *
 * Every factor value is a pure function of its inputs, the `score-v1` constants
 * and the version, and the inputs are integers counted at calculation time —
 * they already encode the time-windowed decisions. So identical inputs under one
 * version imply identical values, and the floats are redundant rather than
 * merely inconvenient. Equality here is exact by construction, not by
 * approximation.
 *
 * ## A breakdown that cannot be read is treated as different
 *
 * `factor_breakdown_json` comes back as `Json`. If a stored breakdown does not
 * parse into the expected shape — written by an older version, or corrupted —
 * `fingerprintOfStored` returns null and the caller writes a new snapshot.
 * Failing towards *recording* is right: a redundant snapshot is noise that
 * compaction removes, while a skipped one is a hole in the user's history.
 */

/** The exact-valued parts of one factor. */
export interface FingerprintFactor {
  id: string;
  excluded: boolean;
  inputs: Record<string, number>;
}

/** Anything comparable: a fresh calculation or a stored snapshot. */
export interface FingerprintSource {
  score: number;
  scoreVersion: string;
  isDemo: boolean;
  factors: readonly FingerprintFactor[];
}

/**
 * A canonical string identifying one score state.
 *
 * A string rather than a hash: it is compared in memory and never stored, and a
 * failing test that prints the two strings is far easier to diagnose than one
 * printing two hex digests.
 *
 * Factors are sorted by id and input keys are sorted, so two structurally
 * identical states built by different code paths cannot differ on ordering —
 * the same reasoning behind `canonicalJson` in ATL-104 and `canonicalise` in
 * ATL-103.
 */
export function scoreFingerprint(source: FingerprintSource): string {
  const factors = [...source.factors]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((factor) => [
      factor.id,
      factor.excluded,
      Object.entries(factor.inputs)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, value]),
    ]);

  return JSON.stringify([source.score, source.scoreVersion, source.isDemo, factors]);
}

/**
 * Rebuilds a fingerprint from a stored snapshot row.
 *
 * Returns null when the stored breakdown cannot be read as the expected shape,
 * which the caller must treat as "different" rather than "same".
 */
export function fingerprintOfStored(stored: {
  score: number;
  scoreVersion: string;
  isDemo: boolean;
  breakdown: unknown;
}): string | null {
  const factors = readFactors(stored.breakdown);
  if (factors === null) return null;

  return scoreFingerprint({
    score: stored.score,
    scoreVersion: stored.scoreVersion,
    isDemo: stored.isDemo,
    factors,
  });
}

/** Defensive read of `factor_breakdown_json`. Any deviation answers null. */
function readFactors(breakdown: unknown): FingerprintFactor[] | null {
  if (typeof breakdown !== "object" || breakdown === null) return null;

  const raw = (breakdown as { factors?: unknown }).factors;
  if (!Array.isArray(raw)) return null;

  const factors: FingerprintFactor[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;

    const { id, excluded, inputs } = entry as {
      id?: unknown;
      excluded?: unknown;
      inputs?: unknown;
    };

    if (typeof id !== "string" || typeof excluded !== "boolean") return null;
    if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return null;

    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(inputs as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      numeric[key] = value;
    }

    factors.push({ id, excluded, inputs: numeric });
  }

  return factors;
}
