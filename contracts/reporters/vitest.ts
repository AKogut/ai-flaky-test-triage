import { z } from 'zod'
import {
  deriveTestId,
  normaliseFilePath,
  type TestError,
  type TestResult,
  type TestRun,
  type TestStatus,
} from '../test-run.js'
import type { RunMetadata } from './playwright.js'

/**
 * Vitest JSON reporter → `TestRun`.
 *
 * Unit failures classify differently from end-to-end failures in practice: far
 * more often `deterministic`, far more often `app_code`. A dataset built only
 * from browser failures would teach the classifier that every failure has a
 * locator in it, so both reporters have to reach the same normalised shape.
 *
 * The important difference from Playwright is what Vitest does **not** record.
 * There is no retry information in the default configuration, and no per-attempt
 * history. That absence is information — it means "we do not know", not "the
 * test passed first time" — and conflating the two would manufacture confidence
 * in the `determinism` axis that the data does not support.
 */

const VitestAssertionSchema = z.looseObject({
  title: z.string(),
  fullName: z.string(),
  ancestorTitles: z.array(z.string()).default([]),
  status: z.enum(['passed', 'failed', 'skipped', 'pending', 'todo']),
  duration: z.number().nullable().optional(),
  failureMessages: z.array(z.string()).default([]),
})

const VitestFileSchema = z.looseObject({
  /** Absolute path on the machine that ran the suite. */
  name: z.string(),
  assertionResults: z.array(VitestAssertionSchema),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
})

export const VitestReportSchema = z.looseObject({
  startTime: z.number(),
  testResults: z.array(VitestFileSchema),
})

export type VitestReport = z.infer<typeof VitestReportSchema>

const STATUS: Record<z.infer<typeof VitestAssertionSchema>['status'], TestStatus> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  // Vitest's own words for "declared but not run".
  pending: 'skipped',
  todo: 'skipped',
}

/**
 * Vitest reports absolute paths. Everything downstream keys on a
 * repository-relative path, and `testId` is built from it — so an id derived
 * from `/home/runner/work/repo/tests/a.test.ts` locally and
 * `/Users/x/repo/tests/a.test.ts` in CI would be two different tests with two
 * separate histories.
 */
export function toRepositoryPath(absolute: string, repositoryRoot: string): string {
  const root = normaliseFilePath(repositoryRoot).replace(/\/+$/, '')
  const path = normaliseFilePath(absolute)
  return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/**
 * Vitest concatenates failure messages; the first line is the assertion and the
 * rest is the stack. Splitting them keeps the error shape identical to
 * Playwright's, so nothing downstream has to know which reporter it came from.
 */
function toError(messages: string[]): TestError | undefined {
  const raw = messages[0]
  if (raw === undefined || raw.trim() === '') return undefined

  const lines = raw.split('\n')
  const firstFrame = lines.findIndex((line) => /^\s+at\s/.test(line))
  const message = (firstFrame === -1 ? lines : lines.slice(0, firstFrame)).join('\n').trim()
  const stack = firstFrame === -1 ? undefined : lines.slice(firstFrame).join('\n')

  const error: TestError = { message: message === '' ? raw.trim() : message }
  if (stack !== undefined) error.stack = stack
  return error
}

/**
 * Validate a Vitest JSON report and normalise it.
 *
 * `repositoryRoot` is required rather than inferred from `process.cwd()`: this
 * has to stay a pure function so it can be tested without a filesystem, and
 * because the path that matters is the checkout root, not wherever the CLI ran.
 */
export function normaliseVitestReport(
  raw: unknown,
  meta: RunMetadata & { repositoryRoot: string },
): TestRun {
  const parsed = VitestReportSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Not a Vitest JSON report. The reporter format may have changed:\n${issues}\n` +
        `Update contracts/reporters/vitest.ts and the fixture in tests/fixtures/reporters/.`,
    )
  }

  const results: TestResult[] = []
  let latestEnd = parsed.data.startTime

  for (const file of parsed.data.testResults) {
    const path = toRepositoryPath(file.name, meta.repositoryRoot)
    latestEnd = Math.max(latestEnd, file.endTime ?? parsed.data.startTime)

    for (const assertion of file.assertionResults) {
      // `fullName` already includes the ancestor titles, but it joins them with
      // a space, so `describe('a') > it('b c')` and `describe('a b') > it('c')`
      // collapse to the same string. Rebuilding from the parts keeps them apart
      // and matches the separator the Playwright normaliser uses.
      const title = [...assertion.ancestorTitles, assertion.title].join(' › ')

      const result: TestResult = {
        testId: deriveTestId(path, title),
        title,
        file: path,
        status: STATUS[assertion.status],
        // Vitest does not retry by default and records no per-attempt history.
        attempts: 1,
        flakyWithinRun: false,
        durationMs: assertion.duration ?? 0,
        annotations:
          assertion.status === 'todo'
            ? ['todo']
            : assertion.status === 'pending'
              ? ['pending']
              : [],
      }

      const error = toError(assertion.failureMessages)
      if (error !== undefined) result.error = error

      results.push(result)
    }
  }

  return {
    runId: meta.runId,
    commitSha: meta.commitSha,
    branch: meta.branch,
    startedAt: new Date(parsed.data.startTime).toISOString(),
    durationMs: Math.max(0, latestEnd - parsed.data.startTime),
    source: 'vitest',
    results,
  }
}
