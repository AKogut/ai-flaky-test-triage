import { selectForTriage, type AnalysedTest, type Analysis } from '@sentra/contracts'

/**
 * Which failures get looked at, in what order, and how many at once.
 *
 * Pure. Every decision here is one that can be wrong in a way no test of an
 * individual agent would catch — the order the budget is spent in, what happens
 * when it runs out mid-run, whether a run with nothing wrong calls a model at
 * all — so they live in one module with no transport in sight.
 */

/**
 * Concurrent agent calls. Four is the documented default.
 *
 * High enough that a run with a dozen failures is not serialised behind the
 * slowest call, low enough to stay well inside a rate limit on a shared
 * organisation key — and, more to the point, low enough that a budget overrun is
 * bounded by four calls rather than by however many the runner could start.
 */
export const DEFAULT_CONCURRENCY = 4

/**
 * How uncertain a test's owner is, before any model has looked at it.
 *
 * The ordering rule, and the non-obvious part of this file. Work is sorted most
 * ambiguous first, so that if the budget runs out the cases dropped are the ones
 * a heuristic could have handled anyway. Processing in file order spends the
 * budget alphabetically, which is the same as spending it at random.
 *
 * Two signals, in order:
 *
 * **A test that alternates is ambiguous about its owner.** A steady failure is
 * usually a regression or a stale expectation and both are cheap to read off the
 * diff; an intermittent one is where the two axes actually disagree.
 *
 * **A test that failed within the run and passed on retry is more ambiguous
 * still.** That is the strongest intermittency evidence there is, and the
 * hardest case in the taxonomy — `app_code` and `test_code` produce the same
 * symptom.
 */
export function ambiguity(test: AnalysedTest): number {
  const alternation = test.signal.flakinessScore
  const retried = test.result.flakyWithinRun ? 1 : 0
  // A long unbroken streak is evidence *against* ambiguity: it stopped changing.
  const settled = Math.min(test.signal.consecutiveFailures, 10) / 10
  return retried + alternation - settled * 0.5
}

/**
 * The work list: what to triage, hardest first.
 *
 * Ties break on `testId` rather than on nothing. Two tests with identical
 * signals are common — a shared `beforeEach` that fails takes several with it —
 * and an unstable order there would make the report reshuffle between runs of
 * the same commit, which is the sort of diff that teaches people to stop reading
 * reports.
 */
export function workList(analysis: Analysis): AnalysedTest[] {
  return [...selectForTriage(analysis)].sort(
    (a, b) => ambiguity(b) - ambiguity(a) || a.result.testId.localeCompare(b.result.testId),
  )
}

export interface MapOptions {
  concurrency?: number
  /** Consulted before each dispatch. Returning false stops starting new work. */
  shouldContinue?: () => boolean
}

export interface MappedOutcome<T> {
  /** Results in the order of the input, whatever order they finished in. */
  results: (T | undefined)[]
  /** Indices never dispatched because `shouldContinue` said to stop. */
  skipped: number[]
}

/**
 * Run `work` over `items` with a concurrency cap, preserving input order.
 *
 * Ordering is the point. `Promise.all` over a mapped array would also preserve
 * it, but it dispatches everything at once; a pool that pushes results as they
 * land preserves nothing. So results are written into a slot by index, and the
 * report reads the same on every run of the same commit regardless of which call
 * came back first.
 *
 * `shouldContinue` is checked before each dispatch rather than after each
 * result, so a budget that runs out stops the *next* call rather than being
 * discovered by a call that already spent money.
 */
export async function mapWithLimit<I, T>(
  items: readonly I[],
  work: (item: I, index: number) => Promise<T>,
  options: MapOptions = {},
): Promise<MappedOutcome<T>> {
  const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const shouldContinue = options.shouldContinue ?? ((): boolean => true)

  const results: (T | undefined)[] = Array.from({ length: items.length })
  const skipped: number[] = []
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return

      const item = items[index]
      if (item === undefined) return
      if (!shouldContinue()) {
        skipped.push(index)
        continue
      }
      results[index] = await work(item, index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return { results, skipped: skipped.sort((a, b) => a - b) }
}

/**
 * Whether this run has anything worth spending a model call on.
 *
 * A green run produces no report and no comment. Not "an empty report" — a
 * comment saying nothing went wrong, posted on every green pull request, is
 * noise that trains people to skip the one that matters.
 */
export function hasWork(analysis: Analysis): boolean {
  return selectForTriage(analysis).length > 0
}
