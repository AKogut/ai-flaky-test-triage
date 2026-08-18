import { describe, expect, it } from 'vitest'
import {
  emptyHistory,
  type FlakySignal,
  type History,
  type TestResult,
  type TestRun,
} from '@sentra/contracts'
import { DEFAULT_HALF_LIFE, analyse, historyDepth } from './analyze.js'
import { mergeRun } from './history.js'

/**
 * The signal over a sequence of runs, rather than over one.
 *
 * Single-run tests miss the whole class of defect that matters here, and they
 * miss it while looking thorough: a score that never decays, a streak that
 * resets on the wrong event, a history that grows past its cap. Every one of
 * those is correct on run one and wrong on run twenty.
 *
 * Each case drives `mergeRun` and `analyse` run by run — the same path
 * `flakemetry:analyze` takes — and asserts the shape of the whole curve.
 */

const TEST_ID = 'tests/e2e/board.spec.ts›shows a row'
const STATUS = { P: 'passed', F: 'failed', T: 'timedOut', S: 'skipped' } as const

const result = (over: Partial<TestResult> = {}): TestResult => ({
  testId: TEST_ID,
  title: 'shows a row',
  file: 'tests/e2e/board.spec.ts',
  status: 'passed',
  attempts: 1,
  flakyWithinRun: false,
  durationMs: 12,
  annotations: [],
  ...over,
})

const run = (over: Partial<TestRun> = {}): TestRun => ({
  runId: 'run-1',
  commitSha: 'abc1234',
  branch: 'main',
  startedAt: '2026-08-01T00:00:00.000Z',
  durationMs: 100,
  source: 'playwright',
  results: [result()],
  ...over,
})

/** Run `n`, a day after run `n - 1`. Built by addition so it stays valid past the 31st. */
const day = (n: number): string =>
  new Date(Date.UTC(2026, 7, 1) + (n - 1) * 86_400_000).toISOString()

interface Step {
  run: number
  signal: FlakySignal
  historyDepth: number
  historyAvailable: boolean
}

/**
 * Drive a whole sequence, one run at a time, and keep every signal along the way.
 *
 * `analyse` is handed the history as it stood before each run and the history is
 * merged after — which is exactly what the CLI does, so a trajectory asserted
 * here is a trajectory production would produce.
 *
 * `letters` may contain a `-` for a run this test did not appear in, which is
 * how a newly-introduced test is expressed.
 */
function trajectory(letters: string, options: { cap?: number; halfLife?: number } = {}): Step[] {
  let history: History = emptyHistory()
  const steps: Step[] = []

  ;[...letters].forEach((letter, index) => {
    const number = index + 1
    const results =
      letter === '-'
        ? [result({ testId: 'some other test' })]
        : [result({ status: STATUS[letter as keyof typeof STATUS] })]
    const current = run({ runId: `run-${String(number)}`, startedAt: day(number), results })

    const analysis = analyse(current, history, {
      analysedAt: day(number),
      ...(options.cap === undefined ? {} : { cap: options.cap }),
      ...(options.halfLife === undefined ? {} : { halfLife: options.halfLife }),
    })
    const signal = analysis.tests.find((t) => t.result.testId === TEST_ID)?.signal
    if (signal !== undefined) {
      steps.push({
        run: number,
        signal,
        historyDepth: analysis.historyDepth,
        historyAvailable: analysis.historyAvailable,
      })
    }

    history = mergeRun(history, current, options.cap === undefined ? {} : { cap: options.cap })
  })

  return steps
}

const scores = (steps: Step[]): number[] => steps.map((s) => s.signal.flakinessScore)
const last = (steps: Step[]): Step => {
  const step = steps.at(-1)
  if (step === undefined) throw new Error('no steps')
  return step
}

// ---------------------------------------------------------------------------
// The five shapes
// ---------------------------------------------------------------------------

describe('a test that always passes', () => {
  const steps = trajectory('P'.repeat(25))

  it('never scores above zero, however long it runs', () => {
    expect(scores(steps).every((s) => s === 0)).toBe(true)
  })

  it('is new exactly once', () => {
    expect(steps.filter((s) => s.signal.isNew)).toHaveLength(1)
    expect(steps[0]?.signal.isNew).toBe(true)
  })

  it('keeps counting runs and keeps its first sighting', () => {
    expect(last(steps).signal).toMatchObject({
      totalRuns: 25,
      firstSeenAt: day(1),
      lastPassedAt: day(25),
      consecutiveFailures: 0,
    })
  })
})

describe('a test that always fails', () => {
  const steps = trajectory('F'.repeat(25))

  /**
   * The headline property of the whole scoring function, over a sequence rather
   * than an assertion. A test that fails every run is broken, not flaky; scoring
   * it high would put every genuine regression into the `intermittent` bucket.
   */
  it('scores zero on every single run', () => {
    expect(scores(steps).every((s) => s === 0)).toBe(true)
  })

  it('never once reports a pass it did not have', () => {
    expect(steps.every((s) => s.signal.lastPassedAt === null)).toBe(true)
  })

  it('grows the failure streak by exactly one per run', () => {
    expect(steps.map((s) => s.signal.consecutiveFailures)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    )
  })
})

describe('a test that alternates every run', () => {
  const steps = trajectory('PF'.repeat(13))

  it('reaches 1 on its second run and stays there', () => {
    expect(scores(steps)[0]).toBe(0)
    expect(
      scores(steps)
        .slice(1)
        .every((s) => s === 1),
    ).toBe(true)
  })

  /** The streak is about the tail, not the total. Alternating means it never builds one. */
  it('never builds a streak longer than one', () => {
    expect(Math.max(...steps.map((s) => s.signal.consecutiveFailures))).toBe(1)
  })
})

describe('a test introduced part-way through', () => {
  // Fifteen runs it is not in, then ten it is.
  const steps = trajectory('-'.repeat(15) + 'PFPFPFPFPF')

  it('appears only in the runs it ran in', () => {
    expect(steps).toHaveLength(10)
    expect(steps[0]?.run).toBe(16)
  })

  /**
   * New to *itself*, not to the suite. The run had fifteen runs of history
   * behind it, and `isNew` has to mean this test rather than this cache.
   */
  it('is new on its first run, against a history that was far from empty', () => {
    expect(steps[0]?.signal.isNew).toBe(true)
    expect(steps[0]?.historyAvailable).toBe(true)
    expect(steps[0]?.historyDepth).toBe(15)
  })

  it('is never new again', () => {
    expect(steps.slice(1).every((s) => !s.signal.isNew)).toBe(true)
  })

  it('dates itself from when it arrived, not from when the suite did', () => {
    expect(last(steps).signal.firstSeenAt).toBe(day(16))
    expect(last(steps).signal.totalRuns).toBe(10)
  })
})

describe('a test that was flaky and recovered', () => {
  const letters = 'PFPFPFPFPF' + 'P'.repeat(12)
  const steps = trajectory(letters)

  /**
   * Hand-checked at the turning point and then every run after it. Ten runs of
   * perfect alternation score 1; from the eleventh every run is a transition
   * that did *not* change, so each one adds weight to the denominator and none
   * to the numerator.
   */
  it('follows the documented curve, run by run', () => {
    expect(scores(steps)).toEqual([
      0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.87, 0.77, 0.68, 0.61, 0.55, 0.49, 0.44, 0.4, 0.37, 0.33,
      0.3,
    ])
  })

  it('only ever falls once the alternation stops', () => {
    const decaying = scores(steps).slice(10)
    for (const [i, score] of decaying.entries()) {
      if (i > 0) expect(score, `run ${String(i + 11)}`).toBeLessThan(decaying[i - 1] ?? 1)
    }
  })

  /**
   * One half-life of stable runs leaves 0.37, not 0.5. The weights halve, but
   * the stable runs are transitions too — they enter the denominator without
   * entering the numerator, so the score falls faster than the weighting alone.
   * Worth pinning because "half-life 10" invites the other reading.
   */
  it('is down to roughly a third after one half-life of quiet, not to a half', () => {
    const afterOneHalfLife = trajectory('PFPFPFPFPF' + 'P'.repeat(DEFAULT_HALF_LIFE))
    expect(last(afterOneHalfLife).signal.flakinessScore).toBeCloseTo(0.37, 2)
  })

  it('is near zero after a month of quiet', () => {
    const quiet = trajectory('PFPFPFPFPF' + 'P'.repeat(40))
    expect(last(quiet).signal.flakinessScore).toBeLessThan(0.05)
  })

  it('forgets faster with a shorter half-life and slower with a longer one', () => {
    const fast = last(trajectory(letters, { halfLife: 3 })).signal.flakinessScore
    const slow = last(trajectory(letters, { halfLife: 30 })).signal.flakinessScore
    expect(fast).toBeLessThan(slow)
  })
})

describe('a regression that never recovers', () => {
  const steps = trajectory('P'.repeat(10) + 'F'.repeat(12))

  /**
   * The shape that makes the two axes worth having. The score *spikes* when the
   * test breaks and then decays as it keeps failing, because a test that keeps
   * failing has stopped alternating. Read on run 11 alone this looks flaky; read
   * over twenty-two runs it is plainly a regression, and the streak says so.
   */
  it('spikes when it breaks and then decays as it stays broken', () => {
    expect(scores(steps)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.13, 0.12, 0.1, 0.09, 0.08, 0.07, 0.07, 0.06, 0.05, 0.05, 0.04,
      0.04,
    ])
  })

  it('says what it is through the streak, which grows while the score falls', () => {
    expect(last(steps).signal.consecutiveFailures).toBe(12)
    expect(last(steps).signal.flakinessScore).toBeLessThan(0.05)
  })

  it('remembers the last time it worked', () => {
    expect(last(steps).signal.lastPassedAt).toBe(day(10))
  })
})

// ---------------------------------------------------------------------------
// The retained window, over a sequence long enough for it to bite
// ---------------------------------------------------------------------------

describe('the cap, over twenty-five runs', () => {
  const CAP = 5
  const letters = 'PFPPFPFPPFPFPPFPFPPFPFPPF'
  const steps = trajectory(letters, { cap: CAP })

  it('never retains more than the cap', () => {
    expect(steps.every((s) => s.signal.statusHistory.length <= CAP)).toBe(true)
  })

  /** Oldest first: the retained window is always the tail of what actually ran. */
  it('evicts oldest first, so the window is the most recent runs at every step', () => {
    for (const step of steps) {
      expect(step.signal.statusHistory, `run ${String(step.run)}`).toBe(
        letters.slice(0, step.run).slice(-CAP),
      )
    }
  })

  /**
   * The reason the count is stored rather than derived. Read it off the entries
   * and every test past the cap reports the cap for ever, and a year of history
   * and a fortnight of it become the same number.
   */
  it('keeps counting runs long after it has stopped keeping them', () => {
    expect(last(steps).signal.totalRuns).toBe(25)
    expect(last(steps).signal.statusHistory).toHaveLength(CAP)
  })

  it('still dates the test from its first run, not from the oldest one retained', () => {
    expect(last(steps).signal.firstSeenAt).toBe(day(1))
  })

  /** A capped window scores the window. Nothing outside it can be read, so nothing outside it counts. */
  it('scores only what it retained', () => {
    const capped = trajectory('F'.repeat(20) + 'PFPFP', { cap: CAP })
    expect(last(capped).signal.flakinessScore).toBe(1)
  })

  /**
   * Depth is what the scoring *could draw on*, so the cap bounds it: with one
   * test and a window of five, five runs are all the file holds. It is the union
   * across tests rather than any one test's window, so a real suite where tests
   * come and go reports more than the cap — but it can never report runs that
   * were evicted from every test at once, and claiming otherwise would overstate
   * the evidence behind every score in the document.
   */
  it('reports what the file holds, which the cap bounds', () => {
    expect(last(steps).historyDepth).toBe(CAP)
    expect(last(steps).signal.totalRuns).toBe(25)
  })

  it('is the union across tests, not one test’s window', () => {
    let history = emptyHistory()
    for (const [index, ids] of [['a', 'b'], ['a'], ['b'], ['c']].entries()) {
      history = mergeRun(
        history,
        run({
          runId: `run-${String(index + 1)}`,
          startedAt: day(index + 1),
          results: ids.map((testId) => result({ testId })),
        }),
        { cap: 1 },
      )
    }
    // Every test retains one entry; between them they name three distinct runs.
    expect(historyDepth(history)).toBe(3)
  })
})
