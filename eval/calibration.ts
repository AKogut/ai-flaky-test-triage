/**
 * Is the confidence number worth anything?
 *
 * A model asked for a confidence returns 0.85 for nearly everything. That number
 * decides whether the root-cause agent runs, so if it carries no information the
 * gate is decorative and the budget is being spent arbitrarily. This module
 * exists to answer the question rather than assume it, and to publish the answer
 * either way.
 *
 * Two different questions, and conflating them is the usual mistake:
 *
 * **Calibration** — when it says 0.8, is it right about 80% of the time?
 * Measured by binning predictions and comparing stated confidence to observed
 * accuracy: the reliability curve, summarised as Expected Calibration Error.
 *
 * **Discrimination** — does a higher number mean a better prediction *at all*?
 * A classifier that says 0.7 for every prediction and is right 70% of the time
 * has a perfect ECE and is useless for ranking, which is the only thing the
 * threshold uses it for. Measured by AUROC, where 0.5 is a coin toss.
 *
 * A confidence can be well calibrated and useless. It cannot be useful and
 * undiscriminating. So the verdict this module produces leads with
 * discrimination, and the report states it in words as well as numbers.
 */

export interface Point {
  confidence: number
  correct: boolean
}

/** Ten equal-width bins, the convention, so the number is comparable to published ones. */
export const BIN_COUNT = 10

export interface Bin {
  lower: number
  upper: number
  count: number
  /** Mean stated confidence of the predictions that landed here. */
  meanConfidence: number
  /** Share of them that were right. */
  accuracy: number
}

export interface Calibration {
  /** Every prediction, not every fixture — see `calibrate`. */
  n: number
  bins: Bin[]
  /** Weighted mean gap between stated confidence and observed accuracy. */
  ece: number
  /**
   * The worst single bin.
   *
   * Reported beside ECE because ECE is an average and averages hide the case
   * that matters: a classifier can post a respectable ECE while being wrong by
   * 40 points in the one bin the threshold sits in.
   */
  mce: number
  /**
   * AUROC over (confidence, correct). 0.5 is no information at all.
   *
   * Null when every prediction was right or every one wrong — the measure is
   * undefined there, and reporting 0.5 would say "no information" about a run
   * that simply had nothing to discriminate between.
   */
  discrimination: number | null
  /**
   * How many distinct confidence values the classifier used.
   *
   * The direct test of "returns 0.85 for everything". A classifier with one
   * value cannot rank anything, whatever its ECE says.
   */
  distinctValues: number
}

/**
 * Bin predictions and measure the gap.
 *
 * One point per **prediction**, not per fixture: with sampling, every sample is
 * a classification the pipeline could have emitted, and each carries its own
 * confidence. They are correlated — five samples of one fixture are not five
 * independent observations — which is why nothing here reports a confidence
 * interval, and why the report says the number is a direction rather than a
 * measurement at this dataset size.
 */
export function calibrate(points: readonly Point[]): Calibration {
  const bins = Array.from({ length: BIN_COUNT }, (_, index) => {
    const lower = index / BIN_COUNT
    const upper = (index + 1) / BIN_COUNT
    const inBin = points.filter((point) => binOf(point.confidence) === index)

    return {
      lower,
      upper,
      count: inBin.length,
      meanConfidence: average(inBin.map((point) => point.confidence)),
      accuracy: average(inBin.map((point) => (point.correct ? 1 : 0))),
    }
  })

  const populated = bins.filter((bin) => bin.count > 0)
  const gaps = populated.map((bin) => Math.abs(bin.accuracy - bin.meanConfidence))

  return {
    n: points.length,
    bins,
    ece: populated.reduce(
      (sum, bin, index) => sum + (bin.count / points.length) * (gaps[index] ?? 0),
      0,
    ),
    mce: gaps.length === 0 ? 0 : Math.max(...gaps),
    discrimination: auroc(points),
    distinctValues: new Set(points.map((point) => point.confidence)).size,
  }
}

/**
 * Which bin a confidence lands in.
 *
 * 1.0 goes in the top bin rather than an eleventh. The bins are half-open on the
 * right except the last, which is the only reading under which they partition
 * [0, 1] — and a lone eleventh bin holding every perfectly-confident prediction
 * would be the most interesting bin on the page, silently.
 */
export const binOf = (confidence: number): number =>
  Math.min(BIN_COUNT - 1, Math.floor(confidence * BIN_COUNT))

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * Area under the ROC curve, by the Mann–Whitney identity.
 *
 * Ties share an average rank, which matters more here than usual: a classifier
 * that returns one value for everything is *entirely* ties, and without the
 * correction it would score 1.0 — a perfect ranking read off a list that has no
 * order in it.
 */
export function auroc(points: readonly Point[]): number | null {
  const right = points.filter((point) => point.correct).length
  const wrong = points.length - right
  if (right === 0 || wrong === 0) return null

  const ranked = [...points].sort((a, b) => a.confidence - b.confidence)
  const ranks = new Array<number>(ranked.length)

  for (let i = 0; i < ranked.length;) {
    let j = i
    while (j + 1 < ranked.length && ranked[j + 1]?.confidence === ranked[i]?.confidence) j++
    const shared = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[k] = shared
    i = j + 1
  }

  const rankSum = ranked.reduce(
    (sum, point, index) => (point.correct ? sum + (ranks[index] ?? 0) : sum),
    0,
  )
  return (rankSum - (right * (right + 1)) / 2) / (right * wrong)
}

// ---------------------------------------------------------------------------
// Deriving the threshold
// ---------------------------------------------------------------------------

/**
 * Accuracy the root-cause agent's input has to clear.
 *
 * The agent spends tokens elaborating on a triage verdict. Below this, most of
 * what it elaborates on is wrong, and a confident wrong hypothesis is worse than
 * none — it redirects attention.
 */
export const TARGET_ACCURACY = 0.7

/**
 * Fewest predictions a threshold may be read off.
 *
 * Without it the sweep picks the highest confidence value in the dataset, where
 * two correct predictions out of two look like 100% accuracy, and the derived
 * threshold is noise with a decimal point.
 */
export const MIN_SUPPORT = 5

export interface SweepRow {
  threshold: number
  count: number
  accuracy: number
  /** Whether this row could be chosen: over target and over the support floor. */
  eligible: boolean
}

export interface Threshold {
  /** Null when no threshold reaches the target with enough support behind it. */
  value: number | null
  accuracyAbove: number
  countAbove: number
  sweep: SweepRow[]
  reason: string
}

/**
 * Read the threshold off the data rather than guessing it.
 *
 * The sweep is over the confidence values the classifier actually produced, not
 * a grid: a threshold between two values it never emits is a threshold that
 * behaves identically to one of them and looks more considered than it is.
 *
 * The **lowest** qualifying value wins. A higher one would clear the target too
 * and pass fewer failures to the root-cause agent, which is a worse trade — the
 * point is to run on everything it can be right about.
 */
export function deriveThreshold(
  points: readonly Point[],
  target: number = TARGET_ACCURACY,
  minSupport: number = MIN_SUPPORT,
): Threshold {
  const candidates = [...new Set(points.map((point) => point.confidence))].sort((a, b) => a - b)

  const sweep = candidates.map((threshold): SweepRow => {
    const above = points.filter((point) => point.confidence >= threshold)
    const accuracy = average(above.map((point) => (point.correct ? 1 : 0)))
    return {
      threshold,
      count: above.length,
      accuracy,
      eligible: accuracy >= target && above.length >= minSupport,
    }
  })

  const chosen = sweep.find((row) => row.eligible)
  if (chosen === undefined) {
    const best = sweep.reduce<SweepRow | null>(
      (a, b) => (a === null || b.accuracy > a.accuracy ? b : a),
      null,
    )

    // Two different failures, and saying the wrong one is worse than saying
    // nothing: "no threshold reaches 70%" printed next to a row showing 100% is
    // a message a reader stops trusting. Short support and low accuracy are
    // separate problems with separate fixes — more fixtures, or a better
    // classifier.
    const starved = sweep.filter((row) => row.accuracy >= target && row.count < minSupport)
    const reason =
      points.length === 0
        ? 'there were no predictions to derive one from'
        : starved.length > 0
          ? `the only thresholds reaching ${pct(target)} do so over fewer than ${String(minSupport)} predictions ` +
            `(best: ${pct(starved[0]?.accuracy ?? 0)} over ${String(starved[0]?.count ?? 0)}), which is noise with a decimal point`
          : `no confidence value reaches ${pct(target)} accuracy at all; the best any threshold managed was ${pct(best?.accuracy ?? 0)}`

    return {
      value: null,
      accuracyAbove: best?.accuracy ?? 0,
      countAbove: best?.count ?? 0,
      sweep,
      reason,
    }
  }

  return {
    value: chosen.threshold,
    accuracyAbove: chosen.accuracy,
    countAbove: chosen.count,
    sweep,
    reason:
      `predictions at or above ${chosen.threshold.toFixed(2)} are right ${pct(chosen.accuracy)} of the time ` +
      `over ${String(chosen.count)} predictions, the lowest value that clears ${pct(target)}`,
  }
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

// ---------------------------------------------------------------------------
// The verdict, in words
// ---------------------------------------------------------------------------

export type Usability = 'unusable' | 'weak' | 'usable'

export interface Verdict {
  usability: Usability
  /** A sentence a reader can act on without reading the table above it. */
  summary: string
}

/**
 * Discrimination decides, then calibration.
 *
 * A confidence can be well calibrated and useless — one value for everything,
 * right at exactly that rate — and the threshold uses it only for ranking. So a
 * good ECE cannot rescue an AUROC of 0.5, and this function refuses to let it.
 *
 * The bands are deliberately coarse. At this dataset size an AUROC of 0.63
 * against one of 0.67 is not a distinction anyone should act on, and printing
 * three of them would invite exactly that.
 */
export function judge(calibration: Calibration, threshold: Threshold): Verdict {
  const { discrimination, ece, distinctValues, n } = calibration

  if (n === 0) {
    return {
      usability: 'unusable',
      summary: 'No predictions were scored, so nothing was measured.',
    }
  }

  // One value, not two. Two levels partition the predictions, which is real
  // ranking information however coarse, and AUROC below judges how good it is.
  // Rejecting two here would call a usable binary signal unusable, which is the
  // same kind of unearned certainty this module exists to avoid.
  if (distinctValues <= 1) {
    return {
      usability: 'unusable',
      summary:
        `The classifier stated one confidence value across all ${String(n)} predictions. ` +
        'A number that does not vary cannot rank anything, whatever its calibration error. ' +
        'Gate the root-cause agent on something else.',
    }
  }

  if (discrimination === null) {
    return {
      usability: 'unusable',
      summary:
        'Every prediction was right, or every one wrong, so discrimination is undefined. ' +
        'Nothing here says whether confidence carries information.',
    }
  }

  if (discrimination < 0.6) {
    return {
      usability: 'unusable',
      summary:
        `Confidence ranks predictions at AUROC ${discrimination.toFixed(2)}, near the 0.50 of a coin toss. ` +
        'It carries no usable signal about whether a classification is right, so gating on it would ' +
        'spend the root-cause budget arbitrarily. The honest move is to gate on something else.',
    }
  }

  const band = discrimination >= 0.7 && ece <= 0.15 ? 'usable' : 'weak'
  return {
    usability: band,
    summary:
      `Confidence ranks predictions at AUROC ${discrimination.toFixed(2)} with an expected calibration error of ${ece.toFixed(3)}. ` +
      (band === 'usable'
        ? `The stated number is close enough to the observed rate to read as a probability. ${describe(threshold)}`
        : `It orders predictions better than chance but the stated number is not the observed rate — treat it as a sortable hint, not a probability. ${describe(threshold)}`) +
      ` At ${String(n)} predictions from a stratified dataset this is a direction, not a measurement.`,
  }
}

const describe = (threshold: Threshold): string =>
  threshold.value === null
    ? `No root-cause threshold could be derived: ${threshold.reason}.`
    : `The root-cause threshold derives to ${threshold.value.toFixed(2)}.`
