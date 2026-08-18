import {
  type AnalysedTest,
  type Analysis,
  type Classification,
  type ClassificationInput,
  type FixSuggestion,
  type RootCause,
} from '@sentra/contracts'
import { suggestFix, type FixSuggestionDeps } from './fix-suggestion.js'
import { BudgetExceededError, type CallTelemetry, type TokenBudget } from './model-client.js'
import { mapWithLimit, workList, type MapOptions } from './orchestrate.js'
import { rootCause, shouldInvestigate, type RootCauseDeps } from './root-cause.js'
import { triage, type TriageDeps } from './triage.js'

/**
 * The three agents, driven over one run's failures.
 *
 * Pure of IO and of transport construction: everything that talks to a network
 * arrives as a dependency, so this file can be driven end to end by a stub and
 * the interesting behaviour — ordering, budget exhaustion, per-test isolation —
 * is testable without a key.
 *
 * The shape worth noticing is that **a failed call is a row, not an exception**.
 * This pipeline analyses CI failures; being unavailable exactly when CI is
 * unhealthy would be a poor joke, and a run with forty failures where the
 * twelfth rate-limits should still deliver thirty-nine classifications and one
 * honest gap. #67 builds on this.
 */

export interface TriagedTest {
  test: AnalysedTest
  classification?: Classification
  rootCause?: RootCause
  fixSuggestion?: FixSuggestion
  /** Paths the root-cause agent named that the checkout does not have. */
  droppedFiles?: string[]
  /** Quoted evidence not present in what the model was shown. */
  unverifiedEvidence?: string[]
  /**
   * Why this row has no classification.
   *
   * A missing row reads as "nothing was wrong with this test", which is the
   * opposite of the truth, so the gap is stated. Budget exhaustion is kept
   * distinct from an API error: one means the run was too big for its
   * allowance, the other means something broke.
   */
  unclassified?: { reason: 'budget' | 'error' | 'not-dispatched' | 'not-run'; detail: string }
}

export interface PipelineResult {
  triaged: TriagedTest[]
  telemetry: CallTelemetry[]
  /** True when at least one test went unclassified for any reason. */
  degraded: boolean
}

export interface PipelineDeps {
  /** Everything the triage agent needs, minus the per-test input. */
  triage: Omit<TriageDeps, 'budget'>
  /** Absent when the downstream agents are not configured; then only triage runs. */
  rootCause?: Omit<RootCauseDeps, 'budget'>
  fixSuggestion?: Omit<FixSuggestionDeps, 'budget'>
  /**
   * Read off the calibration curve. `null` means no calibration has been
   * published, and then no hypothesis is produced at all — see `shouldInvestigate`.
   */
  threshold: number | null
  budget: TokenBudget
  /** Builds the classifier input for a test. Reads files, so the caller owns it. */
  inputFor: (test: AnalysedTest) => ClassificationInput
  concurrency?: number
  onTelemetry?: (telemetry: CallTelemetry) => void
}

/** Budget exhaustion mid-run is expected; anything else is a fault worth naming as one. */
const gap = (error: unknown): NonNullable<TriagedTest['unclassified']> =>
  error instanceof BudgetExceededError
    ? { reason: 'budget', detail: error.message }
    : { reason: 'error', detail: (error as Error).message }

export async function runPipeline(analysis: Analysis, deps: PipelineDeps): Promise<PipelineResult> {
  const work = workList(analysis)
  const telemetry: CallTelemetry[] = []
  const collect = (t: CallTelemetry): void => {
    telemetry.push(t)
    deps.onTelemetry?.(t)
  }

  /**
   * Once the budget has refused a call, the run is over.
   *
   * `TokenBudget.reserve` throws *before* anything is sent, so the refusal
   * itself costs nothing — but every subsequent test would earn its own refusal,
   * and forty identical "budget exceeded" rows say less than one boundary and
   * thirty-nine "never reached". Checking `remaining > 0` instead would only
   * stop when the allowance landed on exactly zero, which it never does.
   */
  let exhausted = false

  const options: MapOptions = {
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    shouldContinue: () => !exhausted,
  }

  const { results, skipped } = await mapWithLimit(
    work,
    async (test): Promise<TriagedTest> => {
      try {
        const input = deps.inputFor(test)
        const triaged = await triage(input, {
          ...deps.triage,
          budget: deps.budget,
          onTelemetry: collect,
        })

        const row: TriagedTest = {
          test,
          classification: triaged.classification,
          unverifiedEvidence: triaged.unverifiedEvidence,
        }

        if (
          deps.rootCause === undefined ||
          !shouldInvestigate(triaged.classification, deps.threshold)
        ) {
          return row
        }

        const cause = await rootCause(
          { ...input, classification: triaged.classification },
          { ...deps.rootCause, budget: deps.budget, onTelemetry: collect },
        )
        row.rootCause = cause.rootCause
        row.droppedFiles = cause.droppedFiles

        if (deps.fixSuggestion === undefined) return row

        const fix = await suggestFix(
          { ...input, classification: triaged.classification, rootCause: cause.rootCause },
          { ...deps.fixSuggestion, budget: deps.budget, onTelemetry: collect },
        )
        row.fixSuggestion = fix.suggestion
        return row
      } catch (error) {
        // One test's failure is one row. Never a dead pipeline.
        if (error instanceof BudgetExceededError) exhausted = true
        return { test, unclassified: gap(error) }
      }
    },
    options,
  )

  const triaged = work.map((test, index) => {
    const done = results[index]
    if (done !== undefined) return done
    return {
      test,
      unclassified: {
        reason: 'not-dispatched' as const,
        detail: 'the run reached its token budget before this test was reached',
      },
    }
  })

  return {
    triaged,
    telemetry,
    degraded: skipped.length > 0 || triaged.some((row) => row.unclassified !== undefined),
  }
}
