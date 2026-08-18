import { z } from 'zod'
import { TestResultSchema } from './test-run.js'

/**
 * The seam between the statistical half of the pipeline and the AI half.
 *
 * `flakemetry-lib` writes this; the agents read it. It is also a committed
 * fixture format — the integration tests and the eval harness both feed
 * hand-written `analysis.json` files — so a change here is a breaking change to
 * data that already exists on disk, which is why it carries a version from the
 * first commit rather than from the first time it hurts.
 *
 * Specified in docs/architecture.md.
 */

/**
 * Major version of the `analysis.json` document.
 *
 * Bumped when a field is removed, renamed, or changes meaning. Adding an
 * optional field is not a bump: old readers keep working, and forcing a bump for
 * additions trains everyone to ignore the number.
 */
export const ANALYSIS_SCHEMA_VERSION = 1

/**
 * A test's recent outcomes, most recent **last**.
 *
 * `P` passed, `F` failed, `T` timed out, `S` skipped. A compact string rather
 * than an array because it is read by humans in reports and prompts far more
 * often than it is computed over, and `PPPFPFPPF` is legible at a glance in a
 * way that nine JSON objects are not.
 */
export const StatusHistorySchema = z.string().regex(/^[PFTS]*$/, {
  message: 'statusHistory must contain only P, F, T or S, most recent last',
})

export const FlakySignalSchema = z
  .object({
    testId: z.string().min(1),

    /**
     * How much the test **alternates**, not how often it fails.
     *
     * A test that fails every single run scores near zero: it is broken, not
     * flaky. Conflating the two would put every genuine regression into the
     * `intermittent` bucket, which is the failure this whole taxonomy exists to
     * avoid.
     */
    flakinessScore: z.number().min(0).max(1),

    consecutiveFailures: z.int().min(0),
    totalRuns: z.int().min(0),

    firstSeenAt: z.iso.datetime(),
    /** Null when the test has never passed in the retained history. */
    lastPassedAt: z.iso.datetime().nullable(),

    statusHistory: StatusHistorySchema,

    /**
     * True when this is the first run in which the test appears.
     *
     * Frequently means history was unavailable rather than that the test is new
     * — a cache miss makes every test look new — so consumers must not read it
     * as "recently added" on its own. `historyAvailable` on the document says
     * which situation this is.
     */
    isNew: z.boolean(),
  })
  .strict()
export type FlakySignal = z.infer<typeof FlakySignalSchema>

export const AnalysedTestSchema = z
  .object({
    result: TestResultSchema,
    signal: FlakySignalSchema,
  })
  .strict()
export type AnalysedTest = z.infer<typeof AnalysedTestSchema>

export const AnalysisSchema = z
  .object({
    schemaVersion: z.int().min(1),

    runId: z.string().min(1),
    commitSha: z.string().min(7),
    branch: z.string().min(1),
    analysedAt: z.iso.datetime(),

    /**
     * False when the history file was missing or empty.
     *
     * Without it, a cache miss and a genuinely new test suite are
     * indistinguishable downstream, and the classifier would report the same
     * confidence for both. The report says so out loud when this is false.
     */
    historyAvailable: z.boolean(),
    /** How many runs of history the scoring could draw on. */
    historyDepth: z.int().min(0),

    /**
     * Why there was history, or why there was not.
     *
     * `historyAvailable` says the signal is thin; this says whose problem that
     * is. A cache that missed is Tuesday — seven idle days, or a first run on a
     * new branch. A cache that was *there and unreadable* means something is
     * writing the file wrongly, and the two produce identical output otherwise:
     * every test new, `determinism` resting on within-run retries, and a
     * pipeline that looks like it is working.
     *
     * Optional because documents written before it existed are still valid, and
     * because only the caller that opened the file knows the answer — `analyse`
     * is handed a history and cannot tell an empty one from an absent one.
     */
    historySource: z.enum(['read', 'missing', 'unreadable']).optional(),

    /** Every test in the run, not only the failures — the agents filter. */
    tests: z.array(AnalysedTestSchema),
  })
  .strict()
export type Analysis = z.infer<typeof AnalysisSchema>

/**
 * What a classifier is given, and nothing else.
 *
 * Named for the job rather than for the file it happens to arrive in. The
 * evaluation reads it out of a `<name>.run.json` fixture and production
 * assembles it from `analysis.json`, a diff and a test source — two paths to the
 * same shape, which is the only way the agent and the baseline can be compared
 * without measuring their inputs instead of themselves.
 *
 * `FixturePayload` extends this with `name` and `scenario`. That direction
 * matters: dataset bookkeeping is added to the classifier's input, never carved
 * out of it, so the fields the eval harness keeps for itself cannot reach a
 * prompt built from this type. Structural rather than remembered.
 */
export const ClassificationInputSchema = z
  .object({
    /** The failing test plus its flakiness signal. */
    subject: AnalysedTestSchema,
    /** Diff of the commit under test, when the scenario involves one. */
    diff: z.string().max(20_000).optional(),
    /** Source of the test itself, when the scenario turns on how it is written. */
    testSource: z.string().max(20_000).optional(),
    /** False when the run had no history to draw on — a cache miss, usually. */
    historyAvailable: z.boolean(),
  })
  .strict()
export type ClassificationInput = z.infer<typeof ClassificationInputSchema>

/**
 * Parse an `analysis.json` document, refusing an incompatible major version.
 *
 * A version mismatch has to be an error rather than a best-effort read: the
 * consumer would otherwise get `undefined` where a field used to be and carry on
 * producing confident, wrong output.
 */
export function parseAnalysis(value: unknown, sourceLabel: string): Analysis {
  const versioned = z.looseObject({ schemaVersion: z.unknown() }).safeParse(value)
  const found = versioned.success ? versioned.data.schemaVersion : undefined

  if (typeof found === 'number' && found !== ANALYSIS_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel} has analysis schemaVersion ${String(found)}, but this build reads ` +
        `version ${String(ANALYSIS_SCHEMA_VERSION)}. Regenerate it with: npm run flakemetry:analyze`,
    )
  }

  const parsed = AnalysisSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(`${sourceLabel} is not a valid analysis document:\n${issues}`)
  }
  return parsed.data
}

/** Tests the agents consider: failures, and anything newly unstable. */
export function selectForTriage(analysis: Analysis): AnalysedTest[] {
  return analysis.tests.filter(
    (t) =>
      t.result.status === 'failed' ||
      t.result.status === 'timedOut' ||
      t.result.flakyWithinRun ||
      (t.signal.flakinessScore > 0 && t.signal.consecutiveFailures > 0),
  )
}
