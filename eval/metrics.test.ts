import type { Determinism, Owner } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { classifyWithBaseline } from '@sentra/agents'
import { loadAllPayloads, loadLabels } from './dataset.js'
import {
  formatProportion,
  marginOfError,
  proportion,
  score,
  wilsonInterval,
  Z_95,
  type Judgement,
} from './metrics.js'

/**
 * The interval maths is checked two ways, because a formula transcribed wrongly
 * still produces plausible numbers and every downstream check would pass.
 *
 * First against published reference values. Second — and this is the one that
 * would catch a subtle algebra slip — against an independent derivation: Wilson
 * is the set of p the score test does not reject, which is the root interval of
 * `p²(n + z²) − p(2np̂ + z²) + np̂² = 0`. That route shares no arithmetic with
 * the closed form under test.
 */
function wilsonViaQuadraticRoots(successes: number, n: number, z = Z_95): [number, number] {
  const p = successes / n
  const z2 = z * z
  const a = n + z2
  const b = -(2 * n * p + z2)
  const c = n * p * p
  const root = Math.sqrt(b * b - 4 * a * c)
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
}

describe('wilsonInterval against published values', () => {
  // Brown, Cai & DasGupta (2001) give (0.018, 0.404) for 1 success in 10 —
  // the worked example for why the normal approximation is unusable at n=10.
  it('matches the 1-of-10 reference', () => {
    const { lower, upper } = wilsonInterval(1, 10)
    expect(lower).toBeCloseTo(0.017876, 6)
    expect(upper).toBeCloseTo(0.40415, 5)
  })

  // Zero events in 20 trials. The one-sided rule of three approximates the upper
  // bound as 3/20 = 0.15; Wilson's two-sided bound is a little above it.
  it('matches the 0-of-20 reference', () => {
    const { lower, upper } = wilsonInterval(0, 20)
    expect(lower).toBe(0)
    expect(upper).toBeCloseTo(0.161125, 6)
  })

  it('matches the 90-of-100 reference', () => {
    const { lower, upper } = wilsonInterval(90, 100)
    expect(lower).toBeCloseTo(0.825634, 6)
    expect(upper).toBeCloseTo(0.944771, 6)
  })

  it('is symmetric about 0.5 at p = 0.5', () => {
    const { lower, upper } = wilsonInterval(50, 100)
    expect(lower).toBeCloseTo(0.403832, 6)
    expect(upper).toBeCloseTo(0.596168, 6)
    expect(lower + upper).toBeCloseTo(1, 12)
  })
})

describe('wilsonInterval against an independent derivation', () => {
  /**
   * Deduplicated, because the generator repeats itself at small `n`: for `n = 1`
   * the six expressions collapse to `k = 0` four times and `k = 1` twice. Six
   * identical cases are six identical assertions, and — since `deriveTestId` is
   * file plus full title — six tests sharing one identity, which would have made
   * them share one row of flakiness history the moment the suite was analysed.
   */
  const cases: [number, number][] = []
  const seen = new Set<string>()
  for (const n of [1, 2, 3, 5, 10, 33, 60, 100, 997]) {
    for (const k of [0, 1, Math.floor(n / 3), Math.floor(n / 2), n - 1, n]) {
      if (k < 0 || k > n || seen.has(`${String(k)}/${String(n)}`)) continue
      seen.add(`${String(k)}/${String(n)}`)
      cases.push([k, n])
    }
  }

  it.each(cases)('agrees with the quadratic roots at %i/%i', (k, n) => {
    const closedForm = wilsonInterval(k, n)
    const [lower, upper] = wilsonViaQuadraticRoots(k, n)
    expect(closedForm.lower).toBeCloseTo(Math.max(0, lower), 12)
    expect(closedForm.upper).toBeCloseTo(Math.min(1, upper), 12)
  })

  it.each(cases)('brackets the point estimate at %i/%i', (k, n) => {
    const { lower, upper } = wilsonInterval(k, n)
    expect(lower).toBeLessThanOrEqual(k / n)
    expect(upper).toBeGreaterThanOrEqual(k / n)
  })

  it.each(cases)('stays inside [0, 1] at %i/%i', (k, n) => {
    const { lower, upper } = wilsonInterval(k, n)
    expect(lower).toBeGreaterThanOrEqual(0)
    expect(upper).toBeLessThanOrEqual(1)
  })
})

describe('why Wilson and not the normal approximation', () => {
  it('does not claim a proportion above certainty where the normal one does', () => {
    // 57 of 60 is inside the range this project will report on. The textbook
    // interval puts the upper bound at 100.5%, which is the whole argument.
    const normalUpper = 57 / 60 + Z_95 * Math.sqrt(((57 / 60) * (3 / 60)) / 60)
    expect(normalUpper).toBeGreaterThan(1)
    expect(wilsonInterval(57, 60).upper).toBeLessThanOrEqual(1)
    expect(wilsonInterval(57, 60).upper).toBeCloseTo(0.98285, 5)
  })

  it('still says something at the edges, where the normal one says nothing', () => {
    // p̂(1-p̂) is 0 at both edges, so the normal interval has zero width and
    // asserts certainty from a handful of observations.
    expect(wilsonInterval(0, 10).upper).toBeCloseTo(0.277533, 6)
    expect(wilsonInterval(10, 10).lower).toBeCloseTo(0.722467, 6)
  })

  it('narrows as the sample grows', () => {
    const widths = [10, 30, 100, 1000].map((n) => {
      const { lower, upper } = wilsonInterval(Math.round(n * 0.9), n)
      return upper - lower
    })
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThan(widths[i - 1] ?? Infinity)
    }
  })
})

describe('degenerate inputs', () => {
  it('treats an empty sample as unconstrained, not as zero', () => {
    // [0, 0] would read as "measured 0%". The truth is "measured nothing".
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 })
    expect(proportion(0, 0).point).toBe(0)
    expect(proportion(0, 0).interval).toEqual({ lower: 0, upper: 1 })
  })

  it('pins the lower bound at exactly 0 when nothing succeeded', () => {
    // Arithmetic can land a few ulps below; a negative probability in a report
    // destroys confidence in every other number on the page.
    for (const n of [1, 7, 60, 1000]) expect(wilsonInterval(0, n).lower).toBe(0)
  })

  it('pins the upper bound at exactly 1 when everything succeeded', () => {
    for (const n of [1, 7, 60, 1000]) expect(wilsonInterval(n, n).upper).toBe(1)
  })

  it.each([
    ['a fractional count', 1.5, 10],
    ['a fractional sample', 1, 10.5],
    ['more successes than trials', 11, 10],
    ['a negative count', -1, 10],
    ['a negative sample', 0, -1],
  ])('refuses %s', (_case, successes, n) => {
    expect(() => wilsonInterval(successes, n)).toThrow()
  })
})

// ---------------------------------------------------------------------------

const judge = (
  actual: [Owner, Determinism],
  predicted: [Owner, Determinism],
  name = 'f',
): Judgement => ({
  name,
  actual: { owner: actual[0], determinism: actual[1] },
  predicted: { owner: predicted[0], determinism: predicted[1] },
})

describe('per-class precision, recall and F1', () => {
  /**
   * Worked by hand so the expected numbers come from the definitions rather
   * than from running the code and recording whatever it said.
   *
   *   #  actual       predicted
   *   1  app_code     app_code     ✓
   *   2  app_code     app_code     ✓
   *   3  app_code     test_code    ✗
   *   4  test_code    app_code     ✗
   *   5  test_code    test_code    ✓
   *   6  environment  app_code     ✗
   *
   *   app_code     support 3, predicted 4, TP 2 → P 0.5,  R 0.667, F1 0.571
   *   test_code    support 2, predicted 2, TP 1 → P 0.5,  R 0.5,   F1 0.5
   *   environment  support 1, predicted 0, TP 0 → P 0/0,  R 0,     F1 0
   */
  const judgements: Judgement[] = [
    judge(['app_code', 'deterministic'], ['app_code', 'deterministic'], '1'),
    judge(['app_code', 'deterministic'], ['app_code', 'deterministic'], '2'),
    judge(['app_code', 'deterministic'], ['test_code', 'deterministic'], '3'),
    judge(['test_code', 'deterministic'], ['app_code', 'deterministic'], '4'),
    judge(['test_code', 'deterministic'], ['test_code', 'deterministic'], '5'),
    judge(['environment', 'deterministic'], ['app_code', 'deterministic'], '6'),
  ]

  const owner = score(judgements).owner
  const classOf = (label: string) => owner.classes.find((c) => c.label === label)

  it('counts support and predictions separately', () => {
    expect(classOf('app_code')).toMatchObject({ support: 3, predictedCount: 4, truePositives: 2 })
    expect(classOf('test_code')).toMatchObject({ support: 2, predictedCount: 2, truePositives: 1 })
    expect(classOf('environment')).toMatchObject({
      support: 1,
      predictedCount: 0,
      truePositives: 0,
    })
  })

  it('divides precision by predictions and recall by support', () => {
    expect(classOf('app_code')?.precision.point).toBeCloseTo(0.5, 10)
    expect(classOf('app_code')?.recall.point).toBeCloseTo(2 / 3, 10)
  })

  it('computes F1 as the harmonic mean', () => {
    expect(classOf('app_code')?.f1).toBeCloseTo(0.5714285714, 9)
    expect(classOf('test_code')?.f1).toBeCloseTo(0.5, 10)
  })

  it('reports a never-predicted class as found-nothing rather than as an error', () => {
    // Precision is 0/0. Reporting 0 is a convention; the interval is what stays
    // honest, because no predictions is no evidence, not evidence of being wrong.
    const environment = classOf('environment')
    expect(environment?.precision.point).toBe(0)
    expect(environment?.precision.n).toBe(0)
    expect(environment?.precision.interval).toEqual({ lower: 0, upper: 1 })
    expect(environment?.recall.point).toBe(0)
    expect(environment?.f1).toBe(0)
  })

  it('macro-averages over every class present in the truth', () => {
    expect(owner.macroF1).toBeCloseTo((0.5714285714 + 0.5 + 0) / 3, 9)
    expect(owner.macroF1Over).toEqual(['app_code', 'test_code', 'environment'])
    expect(owner.macroF1Excluded).toEqual([])
  })

  it('accuracy counts whole fixtures', () => {
    expect(owner.accuracy).toMatchObject({ successes: 3, n: 6 })
  })
})

describe('macro-F1 when a class is missing from the dataset', () => {
  const judgements = [
    judge(['app_code', 'intermittent'], ['app_code', 'intermittent']),
    judge(['test_code', 'intermittent'], ['test_code', 'intermittent']),
  ]

  it('leaves the absent class out and names it', () => {
    // Including it would contribute an F1 of 0 and report a gap in the dataset
    // as a failure of the classifier.
    const owner = score(judgements).owner
    expect(owner.macroF1).toBe(1)
    expect(owner.macroF1Excluded).toEqual(['environment'])
  })

  it('still lists the absent class in the per-class table', () => {
    // Excluded from the average, not hidden — the row is how a reader sees the
    // dataset has no fixtures for it.
    expect(score(judgements).owner.classes.map((c) => c.label)).toContain('environment')
  })
})

describe('joint accuracy', () => {
  it('is the headline: both axes right on the same fixture', () => {
    const judgements = [
      judge(['app_code', 'intermittent'], ['app_code', 'intermittent']),
      judge(['app_code', 'intermittent'], ['app_code', 'deterministic']),
      judge(['app_code', 'intermittent'], ['test_code', 'intermittent']),
    ]
    const m = score(judgements)
    expect(m.owner.accuracy.successes).toBe(2)
    expect(m.determinism.accuracy.successes).toBe(2)
    expect(m.joint.successes).toBe(1)
  })

  it('is strictly lower when the two axes fail on different fixtures', () => {
    // The case that makes reporting axes alone flattering: 67% and 67% here, but
    // only one fixture in three is actually usable.
    const m = score([
      judge(['app_code', 'intermittent'], ['app_code', 'intermittent']),
      judge(['app_code', 'intermittent'], ['test_code', 'intermittent']),
      judge(['app_code', 'intermittent'], ['app_code', 'deterministic']),
    ])
    expect(m.joint.point).toBeLessThan(m.owner.accuracy.point)
    expect(m.joint.point).toBeLessThan(m.determinism.accuracy.point)
  })

  it('equals the axes when every error lands on the same fixture', () => {
    const m = score([
      judge(['app_code', 'intermittent'], ['app_code', 'intermittent']),
      judge(['app_code', 'intermittent'], ['test_code', 'deterministic']),
    ])
    expect(m.joint.point).toBe(m.owner.accuracy.point)
  })

  it('never exceeds either axis, over many random label sets', () => {
    // An invariant, not a sample: if this ever fails, joint accuracy is being
    // computed as something other than the conjunction.
    const owners: Owner[] = ['app_code', 'test_code', 'environment']
    const determinisms: Determinism[] = ['deterministic', 'intermittent']
    let seed = 7
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % max
    }

    for (let trial = 0; trial < 200; trial++) {
      const judgements = Array.from({ length: 1 + next(20) }, () =>
        judge(
          [owners[next(3)] ?? 'app_code', determinisms[next(2)] ?? 'deterministic'],
          [owners[next(3)] ?? 'app_code', determinisms[next(2)] ?? 'deterministic'],
        ),
      )
      const m = score(judgements)
      expect(m.joint.point).toBeLessThanOrEqual(m.owner.accuracy.point)
      expect(m.joint.point).toBeLessThanOrEqual(m.determinism.accuracy.point)
    }
  })

  it('handles an empty judgement set without dividing by zero', () => {
    const m = score([])
    expect(m.n).toBe(0)
    expect(m.joint.interval).toEqual({ lower: 0, upper: 1 })
    expect(m.owner.macroF1).toBe(0)
    expect(Number.isNaN(m.owner.macroF1)).toBe(false)
  })
})

describe('presentation', () => {
  it('renders a proportion with its interval', () => {
    expect(formatProportion(proportion(90, 100))).toBe('90.0% [82.6–94.5] n=100')
  })

  it('refuses to print a point estimate for an empty sample', () => {
    // "0.0%" is a claim. An empty sample does not support one.
    expect(formatProportion(proportion(0, 0))).toBe('n/a (n=0)')
    expect(formatProportion(proportion(0, 0), { withN: false })).toBe('n/a')
  })

  it('reports the margin a reader looks for', () => {
    // 30 of 33 is ±10.2pp — the number that tells a reader a 3pp movement
    // between runs means nothing at this dataset size.
    expect(marginOfError(proportion(30, 33))).toBeCloseTo(10.216, 3)
  })
})

describe('the baseline scored against the committed dataset', () => {
  const metrics = score(
    loadAllPayloads().map(({ name, payload }) => {
      const labels = loadLabels(name)
      return {
        name,
        predicted: classifyWithBaseline(payload),
        actual: { owner: labels.owner, determinism: labels.determinism },
      }
    }),
  )

  /**
   * These numbers are pinned, not asserted loosely, so a change to either the
   * baseline rules or the dataset arrives as a failure with a number in it. When
   * one of these breaks, the question to answer in the PR is which of the two
   * moved and whether the movement was intended.
   */
  it('records joint accuracy, the headline metric', () => {
    expect(metrics.n).toBe(39)
    expect(metrics.joint.successes).toBe(13)
    expect(metrics.joint.point).toBeCloseTo(0.3333, 4)
  })

  it('shows joint accuracy well below either axis', () => {
    // 51.3% and 76.9% look like a classifier that half works. 33.3% is how often
    // it produces an answer a developer could act on, and it is the only one of
    // the three that says so.
    expect(metrics.owner.accuracy.successes).toBe(20)
    expect(metrics.determinism.accuracy.successes).toBe(30)
    expect(metrics.joint.point).toBeLessThan(metrics.owner.accuracy.point - 0.15)
  })

  it('reports an interval wide enough to forbid reading small movements', () => {
    // ±14.2pp at n=39. Any comparison of two runs that differ by less than a
    // third of the dataset is noise, and the interval is what says so out loud.
    expect(marginOfError(metrics.joint)).toBeGreaterThan(14)
    expect(metrics.joint.interval.lower).toBeCloseTo(0.2063, 3)
    expect(metrics.joint.interval.upper).toBeCloseTo(0.4902, 3)
  })

  it('finds two test_code fixtures in twelve, which accuracy alone hides', () => {
    // The stale-test fixtures that carry a real product diff are all called
    // app_code — documented in docs/eval-methodology.md and left deliberately
    // unfixed. The only one it gets right is #53's captured fixture, which has
    // no diff for that rule to fire on. A class with recall 1 in 8 is what the
    // headline accuracy hides.
    const testCode = metrics.owner.classes.find((c) => c.label === 'test_code')
    expect(testCode).toMatchObject({ support: 12, predictedCount: 8, truePositives: 2 })
    expect(testCode?.f1).toBeCloseTo(0.2, 5)
  })

  it('is beaten on owner accuracy by answering "app_code" every time', () => {
    // 23 of 39 fixtures are app_code, so the constant classifier scores 59.0%
    // against the baseline's 51.3%. This is not a defect in the baseline — it is
    // the adversarial dataset working as intended, and it is the clearest
    // argument for why macro-F1 is reported next to accuracy: the constant
    // classifier's macro-F1 is 0.26 against the baseline's 0.36.
    const alwaysAppCode = score(
      loadAllPayloads().map(({ name }) => {
        const labels = loadLabels(name)
        return {
          name,
          predicted: { owner: 'app_code' as const, determinism: 'deterministic' as const },
          actual: { owner: labels.owner, determinism: labels.determinism },
        }
      }),
    )
    expect(alwaysAppCode.owner.accuracy.point).toBeGreaterThan(metrics.owner.accuracy.point)
    expect(alwaysAppCode.owner.macroF1).toBeLessThan(metrics.owner.macroF1)
  })

  it('has overlapping intervals against that constant classifier, so neither wins', () => {
    // The honest reading of the previous test. 54.5% [38.0–70.2] against
    // 63.6% [46.6–77.8] is not evidence of a difference at n=33, and reporting
    // the point estimates alone would invite exactly that claim.
    expect(metrics.owner.accuracy.interval.upper).toBeGreaterThan(0.636)
  })
})
