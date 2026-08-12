import { describe, expect, it } from 'vitest'
import {
  consensus,
  labelsSeen,
  mean,
  standardDeviation,
  summarise,
  type Prediction,
  type SampledFixture,
} from './consistency.js'

const app = (confidence = 0.5): Prediction => ({
  owner: 'app_code',
  determinism: 'intermittent',
  confidence,
})
const test = (confidence = 0.5): Prediction => ({
  owner: 'test_code',
  determinism: 'intermittent',
  confidence,
})
const env = (confidence = 0.5): Prediction => ({
  owner: 'environment',
  determinism: 'deterministic',
  confidence,
})

describe('consensus', () => {
  it('takes the label a majority gave', () => {
    const agreed = consensus([app(), test(), app()])
    expect(agreed.owner).toBe('app_code')
    expect(agreed.stability).toBeCloseTo(2 / 3)
  })

  it('is the sample itself when there is only one', () => {
    expect(consensus([test()])).toMatchObject({ owner: 'test_code', stability: 1 })
  })

  it('reports perfect stability when every sample agreed', () => {
    expect(consensus([app(), app(), app()]).stability).toBe(1)
  })

  /**
   * A fixed tiebreak would make one class win every coin flip, which arrives in
   * the confusion matrix looking like a real bias and comes from nowhere in the
   * classifier.
   */
  it('breaks a tie towards the first sample rather than a fixed label', () => {
    expect(consensus([test(), app()]).owner).toBe('test_code')
    expect(consensus([app(), test()]).owner).toBe('app_code')
  })

  it('treats the pair as the unit, not each axis separately', () => {
    // Two samples agree on `owner` and differ on `determinism`; that is a flip.
    const drifting: Prediction[] = [
      { owner: 'app_code', determinism: 'intermittent', confidence: 0.5 },
      { owner: 'app_code', determinism: 'deterministic', confidence: 0.5 },
    ]
    expect(consensus(drifting).stability).toBe(0.5)
  })

  it("averages confidence, since one sample's number would be arbitrary", () => {
    expect(consensus([app(0.2), app(0.8)]).confidence).toBeCloseTo(0.5)
  })

  it('refuses a fixture with no samples rather than inventing one', () => {
    expect(() => consensus([])).toThrow(RangeError)
  })
})

describe('the labels a fixture gave', () => {
  it('lists them most frequent first, with counts', () => {
    expect(labelsSeen([app(), test(), app()])).toEqual([
      'app_code/intermittent ×2',
      'test_code/intermittent ×1',
    ])
  })

  it('breaks a count tie alphabetically, so the list is stable across runs', () => {
    expect(labelsSeen([test(), app()])).toEqual([
      'app_code/intermittent ×1',
      'test_code/intermittent ×1',
    ])
  })
})

// ---------------------------------------------------------------------------

const fixture = (name: string, samples: Prediction[], actual = app()): SampledFixture => ({
  name,
  samples,
  actual: { owner: actual.owner, determinism: actual.determinism },
})

describe('summarising a run', () => {
  it('reports the mean accuracy of a single run, not of the consensus', () => {
    // Right on two samples of three; the consensus is right, a single run is not always.
    const summary = summarise([fixture('a', [app(), test(), app()])])
    expect(summary.meanJoint).toBeCloseTo(2 / 3)
    expect(summary.samples).toBe(3)
  })

  it('reports the spread across runs', () => {
    const summary = summarise([fixture('a', [app(), test()]), fixture('b', [app(), test()])])
    // Run 0 is fully right, run 1 fully wrong: mean 0.5, spread 0.5.
    expect(summary.meanJoint).toBe(0.5)
    expect(summary.sdJoint).toBe(0.5)
  })

  it('reports no spread when nothing moved', () => {
    expect(summarise([fixture('a', [app(), app()])]).sdJoint).toBe(0)
  })

  it('averages stability across fixtures', () => {
    const summary = summarise([
      fixture('stable', [app(), app()]),
      fixture('flipping', [app(), test()]),
    ])
    expect(summary.selfConsistency).toBe(0.75)
  })

  it('lists the fixtures that flipped, least stable first', () => {
    const summary = summarise([
      fixture('stable', [app(), app(), app()]),
      fixture('wobbles', [app(), app(), test()]),
      fixture('coin-flip', [app(), test(), env()]),
    ])
    expect(summary.unstable.map((row) => row.name)).toEqual(['coin-flip', 'wobbles'])
    expect(summary.unstable[0]?.labels).toHaveLength(3)
  })

  it('says nothing is unstable when nothing is', () => {
    expect(summarise([fixture('a', [app(), app()])]).unstable).toEqual([])
  })

  it('handles an empty dataset without dividing by zero', () => {
    expect(summarise([])).toMatchObject({ samples: 1, meanJoint: 0, selfConsistency: 0 })
  })
})

describe('the statistics', () => {
  it('averages', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(mean([])).toBe(0)
  })

  /**
   * Population, not sample. These N runs are every run that happened, and with
   * N=5 the Bessel correction would widen the reported spread by 12% for no
   * reason a reader could interpret.
   */
  it('takes the population standard deviation', () => {
    expect(standardDeviation([2, 4])).toBe(1)
    expect(standardDeviation([5, 5, 5])).toBe(0)
    expect(standardDeviation([])).toBe(0)
  })
})
