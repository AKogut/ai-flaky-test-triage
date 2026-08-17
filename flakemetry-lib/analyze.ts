import {
  ANALYSIS_SCHEMA_VERSION,
  type AnalysedTest,
  type Analysis,
  type FlakySignal,
  type History,
  type HistoryEntry,
  type TestHistory,
  type TestRun,
  type TestStatus,
} from '@sentra/contracts'
import { mergeRun } from './history.js'

/**
 * The scoring half of `flakemetry-lib`. Pure — no clock, no filesystem.
 *
 * One question decides the shape of everything here: **how much does this test
 * alternate**, not how often it fails. A test that fails on every single run is
 * broken, not flaky, and scoring it high would put every genuine regression into
 * the `intermittent` bucket — which is the one mistake the whole two-axis
 * taxonomy exists to prevent. So the score is built from *changes* of outcome,
 * and the always-failing sequence lands at zero by construction rather than by a
 * special case.
 *
 * The spelling is `analyse`, matching `analysedAt` and `AnalysedTest` next door
 * in the contract. The npm script stays `flakemetry:analyze` because that name
 * is already in the README and in an error message `parseAnalysis` prints.
 *
 * It is a scoring function over a few hundred booleans. The interesting work in
 * this project is elsewhere, and this file is deliberately boring.
 */

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Runs after which an observation counts half as much.
 *
 * Ten, because the question a report answers is "is this test unstable *now*".
 * A test that thrashed a month ago and has been solid since should not read as
 * flaky today, and one that started thrashing yesterday should — inside a
 * working week of CI, not a quarter.
 *
 * Bounded by the retained window either way: at the default cap of 50 runs the
 * oldest entry still counts for about 3% of the newest, so the tail is present
 * without being able to outvote the present.
 */
export const DEFAULT_HALF_LIFE = 10

/**
 * One run's evidence, reduced to what the score reads.
 *
 * `flakyWithinRun` is kept separate from `failed` rather than folded into it
 * because it is an alternation *by itself*: the test failed and passed inside a
 * single run, which is the strongest intermittency evidence one run can produce
 * and the only kind that leaves no trace in the pass/fail sequence.
 */
export interface Outcome {
  failed: boolean
  flakyWithinRun: boolean
}

/** A timeout is a failure that never reached its assertion. Both are failures for scoring. */
const isFailure = (status: TestStatus): boolean => status === 'failed' || status === 'timedOut'

const STATUS_LETTER: Record<TestStatus, string> = {
  passed: 'P',
  failed: 'F',
  timedOut: 'T',
  skipped: 'S',
}

/**
 * Recency-weighted share of **transitions** that changed the outcome.
 *
 * A transition is a run with a run before it to differ from. The first run in a
 * history is not one — it had no opportunity to alternate — and leaving it out
 * of the denominator is what keeps the number interpretable as a share and what
 * makes `PFPFPF` score exactly 1 rather than approaching it. A run that was
 * flaky *within itself* is a transition even in first position: it failed and
 * passed without needing a neighbour.
 *
 * Each transition weighs `0.5 ^ (age / halfLife)`, age counting backwards from
 * the newest. Three consequences, and they are the whole point:
 *
 * - `FFFFFFFF` scores **0**. Nothing changed, so nothing alternated. The
 *   broken-not-flaky case falls out of the definition instead of needing a rule.
 * - `PFPFPFPF` scores **1**.
 * - A test that alternated a month ago and has been stable since decays towards
 *   0 without anybody deciding when to forget it.
 *
 * As the half-life grows the weights flatten, and in the limit this is exactly
 * the plain alternation rate — the share of adjacent runs that differ. That is
 * deliberate: the captured dataset fixtures were scored with the plain rate, so
 * keeping it as the limiting case means recency weighting is the only thing that
 * moved when they were rescored, rather than a second silent change to the
 * denominator hiding inside the first.
 *
 * Skipped runs are dropped before scoring. A skip produced no evidence, and
 * treating it as "did not fail" invents an alternation on *both* sides of it —
 * a quarantined test would score as the flakiest thing in the suite.
 *
 * Rounded to two decimals, which is the precision the report and the prompt
 * render anyway. An unrounded ratio would put `0.30000000000000004` into a
 * committed fixture and into a cassette key.
 */
export function alternationScore(
  outcomes: Outcome[],
  halfLife: number = DEFAULT_HALF_LIFE,
): number {
  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    throw new RangeError(
      `half-life must be a positive number of runs, received ${String(halfLife)}. ` +
        'A half-life of zero weights every run but the newest at nothing, which is not a ' +
        'trend, it is the last result.',
    )
  }

  const decay = 0.5 ** (1 / halfLife)
  let alternated = 0
  let transitions = 0

  outcomes.forEach((outcome, index) => {
    const previous = outcomes[index - 1]
    // Nothing to differ from, and nothing observed inside the run either.
    if (previous === undefined && !outcome.flakyWithinRun) return

    // The newest observation weighs 1; everything older decays from there.
    const weight = decay ** (outcomes.length - 1 - index)
    if (outcome.flakyWithinRun || (previous !== undefined && outcome.failed !== previous.failed)) {
      alternated += weight
    }
    transitions += weight
  })

  // A single run that was not flaky within itself has nothing to divide by, and
  // a test seen once is not evidence of instability either way.
  if (transitions === 0) return 0
  return Math.round((alternated / transitions) * 100) / 100
}

/** Retained runs, as the score reads them. */
export function outcomesFromEntries(entries: HistoryEntry[]): Outcome[] {
  return entries
    .filter((entry) => entry.status !== 'skipped')
    .map((entry) => ({ failed: isFailure(entry.status), flakyWithinRun: entry.flakyWithinRun }))
}

/**
 * The same, for a history that survives only as a `statusHistory` string.
 *
 * Captured dataset fixtures keep the string and not the entries, and this is
 * what lets them be scored by the same definition production uses rather than by
 * a second one that drifts. Within-run retries are unrecoverable from a string,
 * so they read as absent — which understates rather than invents.
 */
export function outcomesFromStatusHistory(history: string): Outcome[] {
  return [...history]
    .filter((letter) => letter !== 'S')
    .map((letter) => ({ failed: letter === 'F' || letter === 'T', flakyWithinRun: false }))
}

/** Convenience for the one caller that has a string rather than entries. */
export function scoreStatusHistory(history: string, halfLife: number = DEFAULT_HALF_LIFE): number {
  return alternationScore(outcomesFromStatusHistory(history), halfLife)
}

// ---------------------------------------------------------------------------
// The per-test signal
// ---------------------------------------------------------------------------

/**
 * Failures at the end of the retained history, counted over the same runs the
 * score reads.
 *
 * Skips are stepped over rather than treated as the end of a streak. A
 * quarantined run tells you nothing about whether the test stopped failing, and
 * resetting the streak on one would report a test as recovered because nobody
 * ran it.
 */
function trailingFailures(outcomes: Outcome[]): number {
  let count = 0
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i]?.failed === true; i -= 1) count += 1
  return count
}

function signalFor(
  testId: string,
  record: TestHistory,
  isNew: boolean,
  halfLife: number,
): FlakySignal {
  const outcomes = outcomesFromEntries(record.entries)
  const lastPassed = [...record.entries].reverse().find((entry) => entry.status === 'passed')

  return {
    testId,
    flakinessScore: alternationScore(outcomes, halfLife),
    consecutiveFailures: trailingFailures(outcomes),
    // Runs ever, not runs retained. `statusHistory` shows the window; this says
    // how much sits behind it, which is what a reader weighing the score needs.
    totalRuns: record.totalRuns,
    firstSeenAt: record.firstSeenAt,
    lastPassedAt: lastPassed?.at ?? null,
    statusHistory: record.entries.map((entry) => STATUS_LETTER[entry.status]).join(''),
    isNew,
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface AnalyseOptions {
  /**
   * When this analysis was produced.
   *
   * A value rather than a clock, so the function stays pure and two runs of the
   * evaluation over the same inputs produce byte-identical documents.
   */
  analysedAt: string
  /** Defaults to {@link DEFAULT_HALF_LIFE}. */
  halfLife?: number
  /** Retained runs per test. Defaults to the history module's cap. */
  cap?: number
}

/**
 * Score a run against the history that existed **before** it.
 *
 * Pre-merge, deliberately. `isNew` means "the first run in which this test
 * appears", and the only way to know that without corner cases is to look at
 * what was there beforehand — deriving it from the merged history breaks the
 * moment the cap evicts a test's earliest entries, or the cap is 1, or a job for
 * an older commit is merged late.
 *
 * The merge happens here too, so the signal describes history *including* this
 * run. The caller writes `mergeRun(history, run)` itself rather than getting it
 * back: one function that scores and one that persists, so a report can be
 * regenerated without touching the file, which is exactly what a pull-request
 * job does.
 */
export function analyse(run: TestRun, history: History, options: AnalyseOptions): Analysis {
  const halfLife = options.halfLife ?? DEFAULT_HALF_LIFE
  const merged = mergeRun(history, run, options.cap === undefined ? {} : { cap: options.cap })

  const tests: AnalysedTest[] = run.results.map((result) => ({
    result,
    signal: signalFor(
      result.testId,
      // `mergeRun` has just recorded every result in the run, so the fallback
      // describes a test as this run alone rather than papering over a gap.
      merged.tests[result.testId] ?? { firstSeenAt: run.startedAt, totalRuns: 1, entries: [] },
      history.tests[result.testId] === undefined,
      halfLife,
    ),
  }))

  const depth = historyDepth(history)

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    runId: run.runId,
    commitSha: run.commitSha,
    branch: run.branch,
    analysedAt: options.analysedAt,
    // Both read the history as it was before this run, so they cannot disagree:
    // `historyAvailable` is false exactly when `historyDepth` is 0.
    historyAvailable: depth > 0,
    historyDepth: depth,
    tests,
  }
}

/**
 * Distinct runs the history holds, across all tests.
 *
 * Not the entry count and not the deepest single test: a suite where one test
 * has forty entries and the rest have one has still only been through forty
 * runs, and the report says how much evidence there was, not how it was
 * distributed.
 */
export function historyDepth(history: History): number {
  const runs = new Set<string>()
  for (const record of Object.values(history.tests)) {
    for (const entry of record.entries) runs.add(entry.runId)
  }
  return runs.size
}
