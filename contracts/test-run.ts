import { z } from 'zod'

/**
 * The narrow waist of the pipeline.
 *
 * Playwright and Vitest emit different shapes. Both are normalised into these
 * types at the boundary, and nothing downstream knows which tool produced a run.
 * That is what makes a reporter upgrade break exactly one file, loudly, instead
 * of silently degrading the flakiness signal three stages later.
 *
 * Schema-first, with types inferred. Keeping a hand-written type in step with a
 * hand-written validator is a guaranteed source of drift, and the drift is
 * invisible: the validator accepts a payload the type says cannot exist.
 *
 * Specified in docs/architecture.md.
 */

/**
 * `timedOut` is deliberately distinct from `failed`.
 *
 * A timeout means the assertion was never reached, which is strong evidence for
 * `environment` or for an unsynchronised test — quite different from an assertion
 * that ran and disagreed. Collapsing the two would erase that signal before the
 * classifier ever sees it.
 */
export const TestStatusSchema = z.enum(['passed', 'failed', 'timedOut', 'skipped'])
export type TestStatus = z.infer<typeof TestStatusSchema>

export const TestErrorSchema = z
  .object({
    message: z.string(),
    stack: z.string().optional(),
    /** Source around the failing line, when the reporter captured it. */
    snippet: z.string().optional(),
    /** Present when the reporter distinguishes expected from actual. */
    expected: z.string().optional(),
    actual: z.string().optional(),
  })
  .strict()
export type TestError = z.infer<typeof TestErrorSchema>

export const TestResultSchema = z
  .object({
    /** Stable across runs: see {@link deriveTestId}. */
    testId: z.string().min(1),
    title: z.string().min(1),
    /** Repository-relative, forward slashes, no leading `./`. */
    file: z.string().min(1),
    status: TestStatusSchema,
    /**
     * Attempts within this run, counting the first. A test that failed and then
     * passed on attempt 2 is intermittency evidence that exists nowhere else, so
     * it must survive normalisation.
     */
    attempts: z.int().min(1),
    /** True when an earlier attempt failed and a later one passed. */
    flakyWithinRun: z.boolean(),
    durationMs: z.number().min(0),

    /**
     * Which worker process ran this test, and when it started.
     *
     * Both optional, because only Playwright reports them — and both are here
     * for one failure shape: a spec that leaves state behind and a *different*
     * spec that fails because of it. The failing test's own evidence is complete
     * and entirely misleading, so the only way to reach the cause is to know
     * what else ran in the same process, in what order.
     *
     * The pipeline discarded these until #168. Worth noting what they are not
     * for: the culprit in a state leak has usually **passed**, so "what else
     * failed in this run" would not contain it.
     */
    workerIndex: z.int().min(0).optional(),
    startedAt: z.iso.datetime().optional(),

    error: TestErrorSchema.optional(),
    annotations: z.array(z.string()).default([]),
  })
  .strict()
export type TestResult = z.infer<typeof TestResultSchema>

export const TestRunSchema = z
  .object({
    runId: z.string().min(1),
    commitSha: z.string().min(7),
    branch: z.string().min(1),
    startedAt: z.iso.datetime(),
    durationMs: z.number().min(0),
    /** Which reporter produced this run. Diagnostic only — no logic branches on it. */
    source: z.enum(['playwright', 'vitest', 'synthetic']),
    results: z.array(TestResultSchema),
  })
  .strict()
export type TestRun = z.infer<typeof TestRunSchema>

/**
 * Derive the identity a test keeps across runs.
 *
 * File path plus full title, because neither alone is stable: titles repeat
 * across files, and a file can be renamed while its tests stay the same. The
 * separator is a character that cannot occur in either part.
 *
 * This is the single definition. History, flakiness scoring, and the golden
 * dataset all key on it, so two implementations that disagree by a normalisation
 * detail — a leading `./`, a backslash on Windows — would silently split one
 * test's history in two and make every intermittent test look new.
 */
export function deriveTestId(file: string, title: string): string {
  return `${normaliseFilePath(file)}›${title.trim()}`
}

/** Repository-relative, forward slashes, no leading `./` or `/`. */
export function normaliseFilePath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * Parse a `TestRun`, throwing a message that names the failing path.
 *
 * Callers at a boundary should use this rather than `TestRunSchema.parse`, so a
 * malformed payload produces one legible error instead of a Zod issue tree.
 */
export function parseTestRun(value: unknown, sourceLabel: string): TestRun {
  const result = TestRunSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    const more =
      result.error.issues.length > 5
        ? `\n  … and ${String(result.error.issues.length - 5)} more`
        : ''
    throw new Error(`${sourceLabel} is not a valid TestRun:\n${issues}${more}`)
  }
  return result.data
}
