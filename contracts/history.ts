import { z } from 'zod'
import { TestStatusSchema } from './test-run.js'

/**
 * The file that carries the `determinism` axis between two CI jobs.
 *
 * Everything else the pipeline needs is derivable from the run in front of it.
 * This is not. Whether a failure is intermittent is a statement about runs that
 * have already finished and whose reports are long gone, and ADR-0001 rules out
 * a database — so the evidence survives as a file, carried by `actions/cache`
 * per ADR-0004.
 *
 * That makes it the one artifact here that is written by a machine, read by a
 * later version of the same machine, and never looked at by anyone. A committed
 * fixture that goes wrong shows up in a diff; this shows up as a classifier that
 * quietly gets worse. Hence a version from the first commit, strict schemas, and
 * a parser that refuses rather than best-efforts — the alternative is a reader
 * that finds `undefined` where a field used to be and carries on scoring.
 *
 * **It is a cache, not a source of truth.** Eviction is an expected operating
 * condition, not an incident. This module's job is to say precisely what is
 * wrong with a file; deciding that the pipeline continues anyway belongs to the
 * caller, and #61 is where that policy lives.
 */

/**
 * Major version of the `.flakemetry/history.json` document.
 *
 * Bumped when a field is removed, renamed, or changes meaning; adding an
 * optional field is not a bump.
 *
 * Unlike `analysis.json` there is no regeneration path — the runs this
 * summarises are gone, so a bump discards everyone's history and every test
 * looks new until it refills. That cost is the point of writing the number down
 * on day one: it has to be paid deliberately, not discovered.
 */
export const HISTORY_SCHEMA_VERSION = 1

/**
 * One test in one run.
 *
 * Deliberately not a whole `TestResult`. Errors, stacks and snippets are
 * evidence about a *particular* failure and belong to the run that produced
 * them; keeping fifty of them per test would multiply the file by two orders of
 * magnitude to store text no scoring function reads. What survives is what the
 * `determinism` axis is computed from, and nothing else.
 */
export const HistoryEntrySchema = z
  .object({
    /**
     * The run this outcome came from.
     *
     * Present so a re-analysis is idempotent rather than additive. GitHub keeps
     * `run_id` stable across "re-run all jobs" — only the attempt number
     * changes — so a re-run that appended instead of replacing would write the
     * same outcome twice and double a test's apparent stability.
     */
    runId: z.string().min(1),

    /** The run's start time, so entries can be ordered by when the evidence was produced. */
    at: z.iso.datetime(),

    status: TestStatusSchema,

    /**
     * Retained because it cannot be recovered from `status`, and it is the
     * strongest intermittency evidence a single run can produce.
     *
     * A test that fails on attempt 1 and passes on attempt 2 is recorded green.
     * Store only the status and a test that does that on *every* run reads back
     * as `PPPPPP` — a perfectly stable test, scored near zero, when it is in
     * fact the most reliably flaky test in the suite.
     */
    flakyWithinRun: z.boolean(),
  })
  .strict()
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

export const TestHistorySchema = z
  .object({
    /**
     * Stored rather than read off the oldest retained entry.
     *
     * The per-test cap evicts from the front, so `entries[0].at` creeps forward
     * as history fills and a test first seen in March would report itself as
     * first seen in June. `isNew` is derived from this, and a signal that says
     * "new" about a year-old test is worse than no signal.
     */
    firstSeenAt: z.iso.datetime(),

    /** Oldest first, matching `statusHistory`, which is most recent last. */
    entries: z.array(HistoryEntrySchema),
  })
  .strict()
export type TestHistory = z.infer<typeof TestHistorySchema>

export const HistorySchema = z
  .object({
    schemaVersion: z.int().min(1),

    /**
     * Keyed by `deriveTestId`, which is the single definition of a test's
     * identity across runs. Two spellings of the same path would split one
     * test's history in two and make both halves look new.
     */
    tests: z.record(z.string().min(1), TestHistorySchema),
  })
  .strict()
export type History = z.infer<typeof HistorySchema>

/**
 * A history with nothing in it — what a first run, or a cache miss, starts from.
 *
 * A function rather than an exported constant on purpose: a shared object would
 * be one careless mutation away from every caller in the process inheriting
 * another run's tests.
 */
export function emptyHistory(): History {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, tests: {} }
}

/**
 * A history file that cannot be used, with the reason separated from the prose.
 *
 * `reason` exists so the caller can branch without matching on a message.
 * Degrading on a cache-shaped problem while still failing loudly on a bug is the
 * whole of #61, and a `catch` that greps English is how that distinction gets
 * lost the first time someone rewords an error.
 */
export class HistoryUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly reason: 'unparsable' | 'invalid' | 'version',
    detail: string,
  ) {
    super(
      [
        `${file} cannot be read as run history: ${detail}`,
        '',
        'History is a cache, not a source of truth. Deleting it costs the determinism',
        'signal until it refills — every test reads as new meanwhile — and costs nothing else:',
        '',
        `    rm ${file}`,
      ].join('\n'),
    )
    this.name = 'HistoryUnreadableError'
  }
}

/**
 * Parse a history document, refusing an incompatible major version.
 *
 * The version is checked before the shape so a rollback reports the real
 * problem. Validating first would produce a list of unexpected fields, which
 * reads like a corrupt file and sends whoever is on the pipeline looking in the
 * wrong place.
 */
export function parseHistory(value: unknown, file: string): History {
  const versioned = z.looseObject({ schemaVersion: z.unknown() }).safeParse(value)
  const found = versioned.success ? versioned.data.schemaVersion : undefined

  if (typeof found === 'number' && found !== HISTORY_SCHEMA_VERSION) {
    throw new HistoryUnreadableError(
      file,
      'version',
      `written by schema version ${String(found)}, this build reads version ` +
        `${String(HISTORY_SCHEMA_VERSION)}`,
    )
  }

  const parsed = HistorySchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    const more =
      parsed.error.issues.length > 5
        ? `\n  … and ${String(parsed.error.issues.length - 5)} more`
        : ''
    throw new HistoryUnreadableError(file, 'invalid', `\n${issues}${more}`)
  }
  return parsed.data
}
