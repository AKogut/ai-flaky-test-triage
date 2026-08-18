import type { AnalysedTest, Analysis } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONCURRENCY, ambiguity, hasWork, mapWithLimit, workList } from './orchestrate.js'

const test = (
  testId: string,
  over: {
    status?: AnalysedTest['result']['status']
    flaky?: number
    streak?: number
    retried?: boolean
  } = {},
): AnalysedTest => ({
  result: {
    testId,
    title: testId,
    file: `tests/e2e/${testId}.spec.ts`,
    status: over.status ?? 'failed',
    attempts: 1,
    flakyWithinRun: over.retried ?? false,
    durationMs: 1,
    annotations: [],
  },
  signal: {
    testId,
    flakinessScore: over.flaky ?? 0,
    consecutiveFailures: over.streak ?? 1,
    totalRuns: 20,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastPassedAt: null,
    statusHistory: 'PF',
    isNew: false,
  },
})

const analysis = (tests: AnalysedTest[]): Analysis => ({
  schemaVersion: 1,
  runId: 'r',
  commitSha: 'abc1234',
  branch: 'main',
  analysedAt: '2026-08-18T00:00:00.000Z',
  historyAvailable: true,
  historyDepth: 20,
  tests,
})

describe('the order work is done in', () => {
  /**
   * The ordering rule, and the whole reason this is not a for-loop over the
   * file. If the budget runs out, the cases dropped should be the ones a
   * heuristic could have handled anyway.
   */
  it('puts the most ambiguous first, not the alphabetically first', () => {
    const list = workList(
      analysis([
        test('aaa-steady', { streak: 9 }),
        test('zzz-alternating', { flaky: 0.8 }),
        test('mmm-retried', { retried: true, status: 'passed' }),
      ]),
    )
    expect(list.map((t) => t.result.testId)).toEqual([
      'mmm-retried',
      'zzz-alternating',
      'aaa-steady',
    ])
  })

  /** A test that failed and passed within one run is the hardest case in the taxonomy. */
  it('ranks a within-run retry above a merely alternating history', () => {
    expect(ambiguity(test('a', { retried: true, status: 'passed' }))).toBeGreaterThan(
      ambiguity(test('b', { flaky: 0.9 })),
    )
  })

  /** A long unbroken streak is evidence against ambiguity: it stopped changing. */
  it('ranks a settled failure below an unsettled one', () => {
    expect(ambiguity(test('a', { flaky: 0.5, streak: 10 }))).toBeLessThan(
      ambiguity(test('b', { flaky: 0.5, streak: 1 })),
    )
  })

  /**
   * A shared beforeEach that fails takes several tests with it, so identical
   * signals are common. An unstable order there reshuffles the report between
   * runs of the same commit, which teaches people to stop reading it.
   */
  it('breaks ties on the test id, so the same commit reports the same way twice', () => {
    const list = workList(analysis([test('b'), test('c'), test('a')]))
    expect(list.map((t) => t.result.testId)).toEqual(['a', 'b', 'c'])
  })

  it('considers only what is worth triaging', () => {
    const list = workList(
      analysis([test('failed'), test('green', { status: 'passed', streak: 0 })]),
    )
    expect(list.map((t) => t.result.testId)).toEqual(['failed'])
  })
})

describe('a run with nothing wrong', () => {
  /**
   * No report and no comment — not an empty report. A comment saying nothing
   * went wrong, posted on every green pull request, is noise that trains people
   * to skip the one that matters.
   */
  it('has no work at all', () => {
    expect(hasWork(analysis([test('green', { status: 'passed', streak: 0 })]))).toBe(false)
    expect(workList(analysis([test('green', { status: 'passed', streak: 0 })]))).toEqual([])
  })

  it('is distinguished from a run with something wrong', () => {
    expect(hasWork(analysis([test('failed')]))).toBe(true)
  })
})

describe('the concurrency cap', () => {
  const slow = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    await mapWithLimit(
      Array.from({ length: 12 }, (_, i) => i),
      async (i) => {
        running += 1
        peak = Math.max(peak, running)
        await slow(i % 3)
        running -= 1
        return i
      },
      { concurrency: 3 },
    )
    expect(peak).toBe(3)
  })

  it('defaults to four', async () => {
    let peak = 0
    let running = 0
    await mapWithLimit(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        running += 1
        peak = Math.max(peak, running)
        await slow(1)
        running -= 1
      },
    )
    expect(peak).toBe(DEFAULT_CONCURRENCY)
  })

  /**
   * Ordering is the point. A pool that pushes results as they land preserves
   * nothing, and the report would reshuffle depending on which call came back
   * first.
   */
  it('returns results in input order however they finish', async () => {
    const { results } = await mapWithLimit(
      [30, 1, 20, 2],
      async (ms) => {
        await slow(ms)
        return ms
      },
      { concurrency: 4 },
    )
    expect(results).toEqual([30, 1, 20, 2])
  })

  it('handles an empty list without dispatching anything', async () => {
    let calls = 0
    const outcome = await mapWithLimit([], () => {
      calls += 1
      return Promise.resolve()
    })
    expect(calls).toBe(0)
    expect(outcome.results).toEqual([])
  })
})

describe('stopping cleanly', () => {
  /**
   * Checked before each dispatch rather than after each result, so a budget that
   * runs out stops the *next* call rather than being discovered by one that
   * already spent money.
   */
  it('stops starting work and records what it skipped', async () => {
    let done = 0
    const outcome = await mapWithLimit(
      [0, 1, 2, 3, 4, 5],
      (i) => {
        done += 1
        return Promise.resolve(i)
      },
      { concurrency: 1, shouldContinue: () => done < 2 },
    )

    expect(done).toBe(2)
    expect(outcome.skipped).toEqual([2, 3, 4, 5])
    expect(outcome.results.slice(0, 2)).toEqual([0, 1])
  })

  it('leaves a skipped slot undefined rather than shifting the rest up', async () => {
    const outcome = await mapWithLimit([0, 1, 2], (i) => Promise.resolve(i), {
      concurrency: 1,
      shouldContinue: (): boolean => false,
    })
    expect(outcome.results).toEqual([undefined, undefined, undefined])
    expect(outcome.skipped).toEqual([0, 1, 2])
  })
})
