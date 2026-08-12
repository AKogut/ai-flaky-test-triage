import { describe, expect, it } from 'vitest'
import {
  auroc,
  binOf,
  BIN_COUNT,
  calibrate,
  deriveThreshold,
  judge,
  MIN_SUPPORT,
  TARGET_ACCURACY,
  type Point,
} from './calibration.js'

const points = (...pairs: [confidence: number, correct: boolean][]): Point[] =>
  pairs.map(([confidence, correct]) => ({ confidence, correct }))

/** `n` predictions at `confidence`, of which `right` were correct. */
const group = (confidence: number, n: number, right: number): Point[] =>
  Array.from({ length: n }, (_, index) => ({ confidence, correct: index < right }))

describe('binning', () => {
  it.each([
    [0, 0],
    [0.05, 0],
    [0.1, 1],
    [0.55, 5],
    [0.99, 9],
  ])('puts %s in bin %s', (confidence, bin) => {
    expect(binOf(confidence)).toBe(bin)
  })

  /**
   * A lone eleventh bin holding every perfectly-confident prediction would be
   * the most interesting bin on the page, and it would not be on the page.
   */
  it('puts 1.0 in the top bin rather than an eleventh', () => {
    expect(binOf(1)).toBe(BIN_COUNT - 1)
  })

  it('keeps every bin, so an empty one is visible as empty', () => {
    const calibration = calibrate(points([0.85, true]))
    expect(calibration.bins).toHaveLength(BIN_COUNT)
    expect(calibration.bins.filter((bin) => bin.count > 0)).toHaveLength(1)
  })
})

describe('expected calibration error', () => {
  it('is zero for a perfectly calibrated classifier', () => {
    // Says 0.8 and is right 8 times in 10; says 0.4 and is right 4 in 10.
    const calibration = calibrate([...group(0.8, 10, 8), ...group(0.4, 10, 4)])
    expect(calibration.ece).toBeCloseTo(0, 10)
  })

  it('measures the gap where there is one', () => {
    // Says 0.9 across the board and is right half the time.
    expect(calibrate(group(0.9, 10, 5)).ece).toBeCloseTo(0.4)
  })

  it('weights bins by how many predictions are in them', () => {
    // 90 predictions perfectly calibrated, 10 wrong by 0.5 → 0.05.
    const calibration = calibrate([...group(0.5, 90, 45), ...group(0.9, 10, 4)])
    expect(calibration.ece).toBeCloseTo(0.05, 3)
  })

  /**
   * ECE is an average, and averages hide the case that matters: a classifier can
   * post a respectable ECE while being wrong by 40 points in the one bin the
   * threshold sits in.
   */
  it('reports the worst single bin beside the average', () => {
    const calibration = calibrate([...group(0.5, 90, 45), ...group(0.9, 10, 4)])
    expect(calibration.mce).toBeCloseTo(0.5)
    expect(calibration.mce).toBeGreaterThan(calibration.ece)
  })

  it('is zero when there is nothing to score', () => {
    expect(calibrate([])).toMatchObject({ n: 0, ece: 0, mce: 0, discrimination: null })
  })
})

describe('discrimination', () => {
  it('is 1 when confidence orders predictions perfectly', () => {
    expect(auroc(points([0.9, true], [0.8, true], [0.3, false], [0.2, false]))).toBe(1)
  })

  it('is 0 when it orders them exactly backwards', () => {
    expect(auroc(points([0.9, false], [0.2, true]))).toBe(0)
  })

  /**
   * The failure this whole module exists for. A classifier that says 0.85 for
   * everything and is right most of the time can post a fine ECE; without the
   * tie correction it would also post an AUROC of 1.0 — a perfect ranking read
   * off a list with no order in it.
   */
  it('is 0.5 when every prediction states the same confidence', () => {
    expect(auroc(group(0.85, 10, 7))).toBe(0.5)
  })

  it('is undefined when everything was right, or everything wrong', () => {
    expect(auroc(group(0.8, 5, 5))).toBeNull()
    expect(auroc(group(0.8, 5, 0))).toBeNull()
  })

  it('counts the distinct values, which is the direct test of a constant', () => {
    expect(calibrate(group(0.85, 10, 7)).distinctValues).toBe(1)
    expect(calibrate([...group(0.85, 5, 3), ...group(0.6, 5, 2)]).distinctValues).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe('deriving the threshold', () => {
  it('picks the lowest value that clears the target with support behind it', () => {
    const derived = deriveThreshold([
      ...group(0.9, 6, 6), // 100% here
      ...group(0.7, 6, 4), // 83% at or above 0.7
      ...group(0.4, 6, 0), // 56% at or above 0.4
    ])
    expect(derived.value).toBe(0.7)
    expect(derived.countAbove).toBe(12)
  })

  /**
   * A higher threshold clears the target too and passes fewer failures to the
   * root-cause agent, which is a worse trade — the point is to run it on
   * everything it can be right about.
   */
  it('prefers the lower of two qualifying values', () => {
    const derived = deriveThreshold([...group(0.9, 6, 6), ...group(0.8, 6, 6)])
    expect(derived.value).toBe(0.8)
  })

  it('sweeps only the values the classifier produced', () => {
    const derived = deriveThreshold([...group(0.9, 3, 3), ...group(0.5, 3, 1)])
    expect(derived.sweep.map((row) => row.threshold)).toEqual([0.5, 0.9])
  })

  it('refuses a threshold read off too few predictions', () => {
    const derived = deriveThreshold([...group(0.9, 2, 2), ...group(0.3, 20, 0)])
    expect(derived.value).toBeNull()
    expect(derived.countAbove).toBe(2)
  })

  /**
   * "No threshold reaches 70%" printed next to a row showing 100% is a message a
   * reader stops trusting. Short support and low accuracy are different problems
   * with different fixes — more fixtures, or a better classifier.
   */
  it('says which of the two problems it hit', () => {
    const starved = deriveThreshold([...group(0.9, 2, 2), ...group(0.3, 20, 0)])
    expect(starved.reason).toContain('fewer than 5 predictions')

    const inaccurate = deriveThreshold(group(0.9, 20, 4))
    expect(inaccurate.reason).toContain('no confidence value reaches')
  })

  it('says so plainly when there is nothing to derive from', () => {
    const derived = deriveThreshold([])
    expect(derived.value).toBeNull()
    expect(derived.reason).toContain('no predictions')
    expect(derived.sweep).toEqual([])
  })

  it('takes the target and the support floor from the caller', () => {
    const points = [...group(0.9, 2, 2), ...group(0.3, 20, 0)]
    expect(deriveThreshold(points, TARGET_ACCURACY, 2).value).toBe(0.9)
    expect(deriveThreshold(points, 1.01, 1).value).toBeNull()
  })

  it('has a support floor above one, or the top value always wins', () => {
    expect(MIN_SUPPORT).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------

describe('the verdict', () => {
  const verdict = (data: Point[]): ReturnType<typeof judge> =>
    judge(calibrate(data), deriveThreshold(data))

  /**
   * The claim the module is built to defend: a perfect ECE cannot rescue a
   * confidence that does not vary, because ranking is the only thing the
   * threshold uses it for.
   */
  it('calls a constant confidence unusable however well calibrated it is', () => {
    const constant = group(0.7, 20, 14)
    expect(calibrate(constant).ece).toBeCloseTo(0, 10)
    expect(verdict(constant).usability).toBe('unusable')
    expect(verdict(constant).summary).toContain('cannot rank anything')
  })

  /**
   * Two levels partition the predictions, which is real ranking information
   * however coarse. Rejecting it out of hand would be the same unearned
   * certainty in the other direction.
   */
  it('lets a two-level confidence be judged on its ranking rather than dismissed', () => {
    const binary = [...group(0.9, 10, 9), ...group(0.4, 10, 4)]
    expect(calibrate(binary).distinctValues).toBe(2)
    expect(verdict(binary).usability).not.toBe('unusable')
  })

  it('calls a coin toss unusable and says to gate on something else', () => {
    // Alternating right and wrong across a spread of confidences.
    const noise = Array.from({ length: 20 }, (_, index) => ({
      confidence: 0.3 + (index % 10) / 20,
      correct: index % 2 === 0,
    }))
    expect(verdict(noise).usability).toBe('unusable')
    expect(verdict(noise).summary).toContain('gate on something else')
  })

  it('calls a well-ordered, well-calibrated confidence usable', () => {
    const good = [...group(0.9, 10, 9), ...group(0.6, 10, 6), ...group(0.3, 10, 3)]
    const judged = verdict(good)
    expect(judged.usability).toBe('usable')
    expect(judged.summary).toContain('read as a probability')
  })

  it('calls a well-ordered but badly-scaled confidence weak, not usable', () => {
    // Ranks correctly, states numbers far from the observed rate.
    const skewed = [...group(0.95, 10, 6), ...group(0.9, 10, 3), ...group(0.85, 10, 1)]
    const judged = verdict(skewed)
    expect(judged.usability).toBe('weak')
    expect(judged.summary).toContain('sortable hint')
  })

  it('reports the derived threshold in the sentence, or why there is none', () => {
    const good = [...group(0.9, 10, 9), ...group(0.6, 10, 6), ...group(0.3, 10, 3)]
    expect(verdict(good).summary).toMatch(/threshold derives to 0\.\d\d/)

    const starved = [...group(0.9, 2, 2), ...group(0.5, 10, 3), ...group(0.3, 10, 0)]
    expect(verdict(starved).summary).toContain('could be derived')
  })

  it('says nothing was measured when nothing was', () => {
    expect(verdict([]).usability).toBe('unusable')
    expect(verdict([]).summary).toContain('No predictions were scored')
  })

  it('says the dataset is too small to call it a measurement', () => {
    const good = [...group(0.9, 10, 9), ...group(0.6, 10, 6), ...group(0.3, 10, 3)]
    expect(verdict(good).summary).toContain('a direction, not a measurement')
  })

  it('handles a run where every prediction was right', () => {
    const flawless = [...group(0.9, 10, 10), ...group(0.6, 10, 10), ...group(0.3, 10, 10)]
    expect(verdict(flawless).usability).toBe('unusable')
    expect(verdict(flawless).summary).toContain('discrimination is undefined')
  })
})
