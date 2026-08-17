import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_SCHEMA_VERSION,
  emptyHistory,
  parseAnalysis,
  type History,
  type TestResult,
  type TestRun,
} from '@sentra/contracts'
import {
  DEFAULT_HALF_LIFE,
  alternationScore,
  analyse,
  historyDepth,
  outcomesFromStatusHistory,
  scoreStatusHistory,
  type Outcome,
} from './analyze.js'
import { mergeRun } from './history.js'

/**
 * The scoring function, and the document built from it.
 *
 * Most of what is asserted here is one claim in different clothes: the score
 * answers *how much does this test alternate*, never *how often does it fail*. A
 * test that fails on every run is broken, and scoring it as flaky would put
 * every genuine regression into the `intermittent` bucket — the one mistake the
 * two-axis taxonomy exists to prevent.
 */

const result = (over: Partial<TestResult> = {}): TestResult => ({
  testId: 'tests/e2e/board.spec.ts›shows a row',
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

const day = (n: number): string =>
  new Date(Date.UTC(2026, 7, 1) + (n - 1) * 86_400_000).toISOString()

const STATUS = { P: 'passed', F: 'failed', T: 'timedOut', S: 'skipped' } as const

/** A history for one test built from a status string, one run per letter. */
const historyOf = (letters: string, testId = 'tests/e2e/board.spec.ts›shows a row'): History => {
  let history = emptyHistory()
  ;[...letters].forEach((letter, index) => {
    history = mergeRun(
      history,
      run({
        runId: `run-${String(index + 1)}`,
        startedAt: day(index + 1),
        results: [result({ testId, status: STATUS[letter as keyof typeof STATUS] })],
      }),
    )
  })
  return history
}

const ANALYSED_AT = '2026-09-01T00:00:00.000Z'

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

describe('scoring a history', () => {
  /**
   * Hand-checked. `PPF` has three runs, so two transitions; only the last one
   * changed, and it weighs 1 against the older transition's `0.5 ^ (1/10)`, so
   * `1 / (1 + 0.933) = 0.52`.
   */
  it.each([
    ['FFFFFFFF', 0, 'never changed, so it is broken rather than flaky'],
    ['PPPPPPPP', 0, 'never changed'],
    ['F', 0, 'one run is not evidence of anything'],
    ['P', 0, 'one run is not evidence of anything'],
    ['PF', 1, 'one transition, and it changed'],
    ['FP', 1, 'symmetric — direction is not what is being measured'],
    ['PPF', 0.52, 'two transitions, the newer one changed'],
    ['FFP', 0.52, 'symmetric'],
    ['PFPF', 1, 'every transition changed'],
    ['PFPFPFPFPFPFPFPFPFPF', 1, 'still exactly 1, however long it runs'],
    ['PPPPPPPFFF', 0.13, 'a regression: one change, then a streak that changed nothing'],
    ['PPPPPPPPPF', 0.14, 'the same single change, but at the newest run'],
    ['PFFFFFFFFF', 0.08, 'the same single change, nine runs ago'],
  ])('scores %s at %s — %s', (history, expected) => {
    expect(scoreStatusHistory(history)).toBe(expected)
  })

  /**
   * The headline property, stated on its own because everything else follows
   * from it. The always-failing test is the case that would break the taxonomy.
   */
  it('scores a test that always fails below one that alternates once', () => {
    expect(scoreStatusHistory('FFFFFFFFFF')).toBeLessThan(scoreStatusHistory('PPPPPPPPPF'))
    expect(scoreStatusHistory('FFFFFFFFFF')).toBe(0)
  })

  it('is unmoved by which way round the outcomes are', () => {
    expect(scoreStatusHistory('PFPPFP')).toBe(scoreStatusHistory('FPFFPF'))
  })
})

describe('recency', () => {
  /** Same length, same single change — only its age differs. */
  it('weighs a recent change above an old one', () => {
    expect(scoreStatusHistory('PPPPPPPPPF')).toBeGreaterThan(scoreStatusHistory('PFFFFFFFFF'))
  })

  it('forgets faster the shorter the half-life', () => {
    const old = 'PFFFFFFFFF'
    expect(scoreStatusHistory(old, 2)).toBeLessThan(scoreStatusHistory(old, 20))
  })

  it('lifts a recent change higher the shorter the half-life', () => {
    const recent = 'PPPPPPPPPF'
    expect(scoreStatusHistory(recent, 2)).toBeGreaterThan(scoreStatusHistory(recent, 20))
  })

  /**
   * The limiting case is the plain alternation rate — the share of adjacent runs
   * that differ, which is what the captured dataset fixtures were scored with
   * before this existed.
   *
   * Pinned so that recency weighting is the *only* thing that moved when they
   * were rescored. A second change hiding in the denominator would be invisible
   * in the diff of numbers and impossible to attribute afterwards.
   */
  it.each(['PPPPPPPFFF', 'PFPPFPFPPFPPFPF', 'FPPPPFPFFFPPFFPFPPF', 'PPPPPF', 'FPF', 'FPFFFF'])(
    'flattens to the plain alternation rate for %s',
    (history) => {
      const alternations = [...history].filter((s, i) => i > 0 && s !== history[i - 1]).length
      const plain = Math.round((alternations / (history.length - 1)) * 100) / 100
      expect(scoreStatusHistory(history, 1e9)).toBe(plain)
    },
  )

  it('documents its default rather than hiding one', () => {
    expect(DEFAULT_HALF_LIFE).toBe(10)
    expect(scoreStatusHistory('PPPPPPPPPF')).toBe(
      scoreStatusHistory('PPPPPPPPPF', DEFAULT_HALF_LIFE),
    )
  })

  it('refuses a half-life that is not a positive number of runs', () => {
    for (const halfLife of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreStatusHistory('PF', halfLife), String(halfLife)).toThrow(RangeError)
    }
  })
})

describe('what counts as evidence', () => {
  /** A timeout never reached its assertion, but it is still a failure. */
  it('treats a timeout as a failure', () => {
    expect(scoreStatusHistory('PPPT')).toBe(scoreStatusHistory('PPPF'))
    expect(scoreStatusHistory('TTTT')).toBe(0)
  })

  /**
   * The same rule, reached through real history entries rather than through a
   * status string — two code paths, and only one of them was covered. A timeout
   * read as a pass would score `PPPT` as stable and reset the failure streak of
   * a test that has been hanging for a week.
   */
  it('treats a timeout as a failure when it arrives as an entry, not a letter', () => {
    const timedOut = analyse(
      run({ runId: 'run-5', startedAt: day(5), results: [result({ status: 'timedOut' })] }),
      historyOf('PPPT'),
      { analysedAt: ANALYSED_AT },
    ).tests[0]?.signal
    const failed = analyse(
      run({ runId: 'run-5', startedAt: day(5), results: [result({ status: 'failed' })] }),
      historyOf('PPPF'),
      { analysedAt: ANALYSED_AT },
    ).tests[0]?.signal

    expect(timedOut?.statusHistory).toBe('PPPTT')
    expect(timedOut?.flakinessScore).toBe(failed?.flakinessScore)
    expect(timedOut?.consecutiveFailures).toBe(2)
  })

  /**
   * A skip produced no evidence. Counting it as "did not fail" invents an
   * alternation on *both* sides of it, so a quarantined test would score as the
   * flakiest thing in the suite.
   */
  it('drops skipped runs rather than reading them as passes', () => {
    expect(scoreStatusHistory('PSPSP')).toBe(0)
    expect(scoreStatusHistory('FSFSF')).toBe(0)
    expect(scoreStatusHistory('PSF')).toBe(scoreStatusHistory('PF'))
  })

  /**
   * A test that failed and passed inside one run alternated without leaving a
   * trace in the pass/fail sequence. It is the strongest evidence a single run
   * can produce, and the only kind the status string cannot express.
   */
  it('counts a within-run retry as an alternation', () => {
    const steady: Outcome[] = Array.from({ length: 6 }, () => ({
      failed: false,
      flakyWithinRun: false,
    }))
    const retried = steady.map((o, i) => (i === 5 ? { ...o, flakyWithinRun: true } : o))
    expect(alternationScore(steady)).toBe(0)
    expect(alternationScore(retried)).toBeGreaterThan(0)
  })

  it('scores a test that has only ever run once, and retried inside it, at 1', () => {
    expect(alternationScore([{ failed: false, flakyWithinRun: true }])).toBe(1)
  })

  it('scores a test that has only ever run once and did not retry at 0', () => {
    expect(alternationScore([{ failed: true, flakyWithinRun: false }])).toBe(0)
  })

  it('scores nothing at all at 0 rather than dividing by nothing', () => {
    expect(alternationScore([])).toBe(0)
  })
})

describe('the range, over every sequence rather than a sampled few', () => {
  /**
   * Exhaustive instead of random: every pass/fail history up to thirteen runs is
   * 16382 sequences, which is cheap, total, and reproducible — a seeded
   * generator would only ever prove something about the seed.
   */
  const sequences: string[] = []
  for (let length = 1; length <= 13; length += 1) {
    for (let bits = 0; bits < 2 ** length; bits += 1) {
      sequences.push(Array.from({ length }, (_, i) => ((bits >> i) & 1 ? 'F' : 'P')).join(''))
    }
  }

  it('has something to check', () => {
    expect(sequences).toHaveLength(2 ** 14 - 2)
  })

  it('stays within 0..1 for all of them', () => {
    for (const history of sequences) {
      const score = scoreStatusHistory(history)
      expect(score, history).toBeGreaterThanOrEqual(0)
      expect(score, history).toBeLessThanOrEqual(1)
    }
  })

  it('stays within 0..1 at any half-life', () => {
    for (const halfLife of [0.25, 1, 3, 10, 50, 1e6]) {
      for (const history of sequences.slice(0, 2000)) {
        const score = scoreStatusHistory(history, halfLife)
        expect(score, `${history} @ ${String(halfLife)}`).toBeGreaterThanOrEqual(0)
        expect(score, `${history} @ ${String(halfLife)}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('reaches both ends, so the bounds above are not vacuous', () => {
    const scores = sequences.map((h) => scoreStatusHistory(h))
    expect(Math.min(...scores)).toBe(0)
    expect(Math.max(...scores)).toBe(1)
  })

  it('reads a status string into one observation per run that produced evidence', () => {
    expect(outcomesFromStatusHistory('PFTS')).toEqual([
      { failed: false, flakyWithinRun: false },
      { failed: true, flakyWithinRun: false },
      { failed: true, flakyWithinRun: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe('analysing a run', () => {
  const analysis = analyse(
    run({ runId: 'run-4', startedAt: day(4), results: [result({ status: 'failed' })] }),
    historyOf('PPP'),
    { analysedAt: ANALYSED_AT },
  )
  const signal = analysis.tests[0]?.signal

  it('produces a document the contract accepts', () => {
    expect(() => parseAnalysis(analysis, 'analysis.json')).not.toThrow()
    expect(analysis.schemaVersion).toBe(ANALYSIS_SCHEMA_VERSION)
  })

  it('carries the run’s identity, and the timestamp it was handed', () => {
    expect(analysis).toMatchObject({
      runId: 'run-4',
      commitSha: 'abc1234',
      branch: 'main',
      analysedAt: ANALYSED_AT,
    })
  })

  it('ends the status history with the run being analysed', () => {
    expect(signal?.statusHistory).toBe('PPPF')
  })

  it('counts the failures at the end, which is what the streak rule reads', () => {
    expect(signal?.consecutiveFailures).toBe(1)
    expect(
      analyse(run({ runId: 'r', startedAt: day(9) }), historyOf('PFF'), {
        analysedAt: ANALYSED_AT,
      }).tests[0]?.signal.consecutiveFailures,
    ).toBe(0)
  })

  it('reports when the test was first seen and when it last passed', () => {
    expect(signal).toMatchObject({ firstSeenAt: day(1), lastPassedAt: day(3), totalRuns: 4 })
  })

  it('reports no last pass when the retained history holds none', () => {
    const never = analyse(run({ results: [result({ status: 'failed' })] }), emptyHistory(), {
      analysedAt: ANALYSED_AT,
    })
    expect(never.tests[0]?.signal.lastPassedAt).toBeNull()
  })

  /** The agents filter; an analysis that dropped the passes would decide that for them. */
  it('includes every test in the run, not only the failures', () => {
    const both = analyse(
      run({
        results: [
          result({ testId: 'a', status: 'passed' }),
          result({ testId: 'b', status: 'failed' }),
        ],
      }),
      emptyHistory(),
      { analysedAt: ANALYSED_AT },
    )
    expect(both.tests.map((t) => t.result.testId)).toEqual(['a', 'b'])
  })

  it('passes the half-life through to the score', () => {
    const options = { analysedAt: ANALYSED_AT }
    const history = historyOf('PPPPPPPPP')
    const recent = run({
      runId: 'run-10',
      startedAt: day(10),
      results: [result({ status: 'failed' })],
    })
    expect(
      analyse(recent, history, { ...options, halfLife: 2 }).tests[0]?.signal.flakinessScore,
    ).toBeGreaterThan(
      analyse(recent, history, { ...options, halfLife: 20 }).tests[0]?.signal.flakinessScore ?? 1,
    )
  })

  it('passes the cap through, so a shorter window scores a shorter history', () => {
    const capped = analyse(run({ runId: 'run-9', startedAt: day(9) }), historyOf('PFPFPFPF'), {
      analysedAt: ANALYSED_AT,
      cap: 3,
    })
    expect(capped.tests[0]?.signal.statusHistory).toHaveLength(3)
  })

  /**
   * `statusHistory` shows the window; `totalRuns` says how much sits behind it.
   * Reporting the window twice would tell a reader weighing the score that a
   * test with a year of history and one with a fortnight are equally evidenced.
   */
  it('reports runs ever rather than runs retained', () => {
    const capped = analyse(run({ runId: 'run-9', startedAt: day(9) }), historyOf('PFPFPFPF'), {
      analysedAt: ANALYSED_AT,
      cap: 3,
    })
    // Eight runs of `PFPFPFPF`, then a ninth that passed — of which three are kept.
    expect(capped.tests[0]?.signal).toMatchObject({ totalRuns: 9, statusHistory: 'PFP' })
  })
})

describe('whether the test is new, and whether there was any history', () => {
  /**
   * Read from the history as it stood *before* this run. Deriving it from the
   * merged history breaks the moment the cap evicts a test's earliest entries —
   * or the cap is 1, at which point every test in the suite reads as new.
   */
  it('calls a test new when this run is the first it appears in', () => {
    const first = analyse(run(), emptyHistory(), { analysedAt: ANALYSED_AT })
    expect(first.tests[0]?.signal.isNew).toBe(true)
  })

  it('does not call a test new because the cap evicted its earliest runs', () => {
    const analysis = analyse(run({ runId: 'run-9', startedAt: day(9) }), historyOf('PPPPPPPP'), {
      analysedAt: ANALYSED_AT,
      cap: 1,
    })
    expect(analysis.tests[0]?.signal.isNew).toBe(false)
  })

  it('calls a test new even when other tests have history', () => {
    const analysis = analyse(
      run({ runId: 'run-9', startedAt: day(9), results: [result({ testId: 'brand new' })] }),
      historyOf('PPPP'),
      { analysedAt: ANALYSED_AT },
    )
    expect(analysis.tests[0]?.signal.isNew).toBe(true)
    expect(analysis.historyAvailable).toBe(true)
  })

  /**
   * A cache miss and a genuinely new suite are indistinguishable from `isNew`
   * alone, which is why the document says which situation it was.
   */
  it('reports no history available on the first run there has ever been', () => {
    const first = analyse(run(), emptyHistory(), { analysedAt: ANALYSED_AT })
    expect(first).toMatchObject({ historyAvailable: false, historyDepth: 0 })
  })

  it('keeps the flag and the depth from ever disagreeing', () => {
    for (const letters of ['', 'P', 'PPPP', 'PFPFPF']) {
      const analysis = analyse(run({ runId: 'run-99', startedAt: day(20) }), historyOf(letters), {
        analysedAt: ANALYSED_AT,
      })
      expect(analysis.historyAvailable, letters).toBe(analysis.historyDepth > 0)
    }
  })

  /**
   * Runs, not entries. A suite where one test has eight entries and the rest
   * have one has still only been through eight runs, and the report says how
   * much evidence there was rather than how it was spread.
   */
  it('counts distinct runs rather than entries', () => {
    let history = emptyHistory()
    history = mergeRun(
      history,
      run({ runId: 'a', results: [result({ testId: 'x' }), result({ testId: 'y' })] }),
    )
    history = mergeRun(
      history,
      run({ runId: 'b', startedAt: day(2), results: [result({ testId: 'x' })] }),
    )
    expect(historyDepth(history)).toBe(2)
  })

  it('counts nothing when there is nothing', () => {
    expect(historyDepth(emptyHistory())).toBe(0)
  })
})
