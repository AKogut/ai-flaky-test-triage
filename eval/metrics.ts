import { DeterminismSchema, OwnerSchema, type Determinism, type Owner } from '@sentra/contracts'

/**
 * Scoring a classifier against ground truth.
 *
 * Three decisions here are the difference between a number that means something
 * and a number that only looks like it does.
 *
 * **Joint accuracy is the headline.** A fixture counts as correct only when both
 * axes are right. Reporting `owner` and `determinism` separately and letting a
 * reader take the higher one is the most natural way to accidentally flatter a
 * classifier — a model that is 80% on each axis can be anywhere from 60% to 80%
 * jointly, and the difference is exactly the cases where it got half the answer.
 *
 * **Every proportion carries a Wilson interval.** With 33 fixtures a point
 * estimate is close to noise, and publishing one alone invites reading a 3pp
 * move as progress.
 *
 * **Nothing is rounded here.** Rounding is a presentation decision and happens
 * in the formatter, so a macro-average is not computed from already-rounded
 * parts.
 *
 * What these intervals do *not* say is worth stating, because a confidence
 * interval on a hand-built dataset is easy to over-read. The golden dataset is
 * stratified by design — the bucket shares in docs/eval-methodology.md are
 * targets, not the result of sampling anything. So an interval here answers
 * "how much would this number move if the same process produced a different set
 * of fixtures", not "how would this classifier do on CI failures in general".
 * The second question is not one this dataset can answer, and
 * docs/limitations-and-guardrails.md says so.
 *
 * Fixtures marked `lowConfidenceGroundTruth` are excluded from headline metrics
 * and reported separately. That is a filter the caller applies, because this
 * module deliberately knows nothing about the fixture format — it scores pairs
 * of labels. The report writer in #27 owns that partition.
 */

// ---------------------------------------------------------------------------
// Proportions and intervals
// ---------------------------------------------------------------------------

/** Two-sided 95%. `qnorm(0.975)`. */
export const Z_95 = 1.959963984540054

export interface Interval {
  lower: number
  upper: number
}

export interface Proportion {
  successes: number
  n: number
  /**
   * `successes / n`, and `0` when `n` is `0`.
   *
   * At `n = 0` this field carries no information and the interval — the full
   * `[0, 1]` — is the honest statement. Formatters must not print a point
   * estimate for an empty sample; `formatProportion` prints `n/a`.
   */
  point: number
  interval: Interval
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Wilson rather than the normal approximation `p̂ ± z·√(p̂(1-p̂)/n)`, which at the
 * sizes this project reports is not a stylistic preference. At n = 60 the normal
 * interval's upper bound crosses 1.0 once accuracy passes about 0.94 — it claims
 * a proportion can exceed certainty. Publishing that in a document whose entire
 * argument is statistical honesty would undo the argument.
 *
 * It also degrades gracefully at the edges, where the normal approximation
 * collapses to a zero-width interval: 0 successes in 20 trials gives `[0, 0.161]`
 * here, against the normal approximation's `[0, 0]`.
 *
 * The interval is the set of p for which the score test does not reject at
 * level z — equivalently the roots of `p²(n + z²) − p(2np̂ + z²) + np̂² = 0`.
 * The closed form below is algebraically identical; the test suite checks it
 * against those roots computed independently.
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(n)) {
    throw new Error(`wilsonInterval needs whole counts, got ${successes}/${n}`)
  }
  if (n < 0 || successes < 0 || successes > n) {
    throw new Error(`wilsonInterval needs 0 <= successes <= n, got ${successes}/${n}`)
  }

  // No observations constrain nothing. Returning [0, 0] would read as "measured
  // zero" when the truth is "measured nothing".
  if (n === 0) return { lower: 0, upper: 1 }

  const p = successes / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denominator
  const halfWidth = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))

  // The edges are set exactly rather than computed. Both are algebraic
  // identities — at p̂ = 1 the half-width is z²/(2n·denominator), which is
  // precisely what is left over from 1 − centre — but in floating point they
  // come out a few ulps off, and `Math.min(1, …)` does not catch a value that
  // drifted *inwards*. A reported upper bound of 0.9999999999999998, or a lower
  // bound of 2.8e-17, is the kind of detail that makes a reader stop trusting
  // every other number on the page.
  return {
    lower: successes === 0 ? 0 : clamp(centre - halfWidth),
    upper: successes === n ? 1 : clamp(centre + halfWidth),
  }
}

const clamp = (n: number): number => Math.min(1, Math.max(0, n))

export function proportion(successes: number, n: number, z: number = Z_95): Proportion {
  return {
    successes,
    n,
    point: n === 0 ? 0 : successes / n,
    interval: wilsonInterval(successes, n, z),
  }
}

// ---------------------------------------------------------------------------
// Per-class and per-axis
// ---------------------------------------------------------------------------

export interface ClassMetrics {
  label: string
  /** How many fixtures genuinely are this class. */
  support: number
  /** How many the classifier called this class. */
  predictedCount: number
  truePositives: number
  /** Of the ones it called this class, how many were. Denominator is `predictedCount`. */
  precision: Proportion
  /** Of the ones that are this class, how many it found. Denominator is `support`. */
  recall: Proportion
  /** Harmonic mean of the two point estimates. `0` when both are `0`. */
  f1: number
}

export interface AxisMetrics {
  axis: string
  accuracy: Proportion
  /**
   * Unweighted mean F1 across classes.
   *
   * Reported alongside accuracy because the class distribution is not uniform:
   * `app_code` is roughly two thirds of the dataset, so a classifier that
   * answered `app_code` unconditionally would post a respectable accuracy while
   * being useless. Macro-F1 gives the rare classes equal weight and makes that
   * strategy look as bad as it is.
   */
  macroF1: number
  /** Classes the macro average was taken over — those with at least one fixture. */
  macroF1Over: string[]
  /**
   * Classes left out for having no fixtures at all.
   *
   * A class absent from the dataset would otherwise contribute an F1 of 0 and
   * drag the average down, which would report a gap in the *dataset* as a
   * failure of the *classifier*. Naming them keeps that visible rather than
   * silently narrowing the denominator.
   */
  macroF1Excluded: string[]
  classes: ClassMetrics[]
}

export interface Metrics {
  n: number
  /**
   * Both axes correct on the same fixture — the headline metric.
   *
   * Always less than or equal to either axis alone, which the test suite pins as
   * an invariant rather than trusting it to stay true.
   */
  joint: Proportion
  owner: AxisMetrics
  determinism: AxisMetrics
}

/** One fixture's outcome. Carries no fixture format, only the two labels. */
export interface Judgement {
  name: string
  predicted: { owner: Owner; determinism: Determinism }
  actual: { owner: Owner; determinism: Determinism }
}

export function score(judgements: Judgement[], z: number = Z_95): Metrics {
  const jointCorrect = judgements.filter(
    (j) => j.predicted.owner === j.actual.owner && j.predicted.determinism === j.actual.determinism,
  ).length

  return {
    n: judgements.length,
    joint: proportion(jointCorrect, judgements.length, z),
    owner: axisMetrics('owner', judgements, OwnerSchema.options, z),
    determinism: axisMetrics('determinism', judgements, DeterminismSchema.options, z),
  }
}

function axisMetrics(
  axis: 'owner' | 'determinism',
  judgements: Judgement[],
  labels: readonly string[],
  z: number,
): AxisMetrics {
  const correct = judgements.filter((j) => j.predicted[axis] === j.actual[axis]).length

  const classes = labels.map((label): ClassMetrics => {
    const support = judgements.filter((j) => j.actual[axis] === label).length
    const predictedCount = judgements.filter((j) => j.predicted[axis] === label).length
    const truePositives = judgements.filter(
      (j) => j.predicted[axis] === label && j.actual[axis] === label,
    ).length

    const precision = proportion(truePositives, predictedCount, z)
    const recall = proportion(truePositives, support, z)

    return {
      label,
      support,
      predictedCount,
      truePositives,
      precision,
      recall,
      f1: f1Of(precision, recall),
    }
  })

  const counted = classes.filter((c) => c.support > 0)

  return {
    axis,
    accuracy: proportion(correct, judgements.length, z),
    macroF1: counted.length === 0 ? 0 : mean(counted.map((c) => c.f1)),
    macroF1Over: counted.map((c) => c.label),
    macroF1Excluded: classes.filter((c) => c.support === 0).map((c) => c.label),
    classes,
  }
}

/**
 * Harmonic mean of precision and recall.
 *
 * Zero when both are zero, which is the convention rather than a derivation —
 * the harmonic mean is undefined there. It is the right convention because the
 * alternatives are worse: `NaN` poisons every average downstream, and `1` would
 * reward a class the classifier never found and never guessed.
 *
 * A class the classifier never predicts has precision `0/0`, reported as `0` by
 * the same convention in `proportion`. Its interval is still `[0, 1]`, which is
 * the part that stays honest — no predictions means no evidence, not evidence of
 * being wrong.
 */
function f1Of(precision: Proportion, recall: Proportion): number {
  const sum = precision.point + recall.point
  return sum === 0 ? 0 : (2 * precision.point * recall.point) / sum
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * `"87.9% [76.0–94.5] n=33"`.
 *
 * An empty sample prints `n/a` rather than `0.0%`, because `0.0%` is a claim and
 * an empty sample does not support one.
 */
export function formatProportion(p: Proportion, { withN = true } = {}): string {
  if (p.n === 0) return withN ? 'n/a (n=0)' : 'n/a'
  const pct = (x: number): string => (x * 100).toFixed(1)
  const body = `${pct(p.point)}% [${pct(p.interval.lower)}–${pct(p.interval.upper)}]`
  return withN ? `${body} n=${String(p.n)}` : body
}

/** Half the interval's width, in percentage points — the "±" a reader looks for. */
export function marginOfError(p: Proportion): number {
  return ((p.interval.upper - p.interval.lower) / 2) * 100
}
