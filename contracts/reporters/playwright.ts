import { z } from 'zod'
import {
  deriveTestId,
  normaliseFilePath,
  type TestError,
  type TestResult,
  type TestRun,
  type TestStatus,
} from '../test-run.js'

/**
 * Playwright JSON reporter → `TestRun`.
 *
 * Everything Playwright-specific lives in this file. That is the whole point: a
 * major version bump breaks one module with a legible error, rather than
 * corrupting `analysis.json` three stages downstream where the symptom is
 * "every test suddenly looks new".
 *
 * Three things in the source format carry signal that is easy to lose:
 *
 *  - Suites nest recursively, and a test's identity is its **full** title. Taking
 *    only the leaf would merge `reorder › moves up` with any other `moves up`.
 *  - Retries are separate entries in `results[]`. A test that failed and then
 *    passed is the strongest within-run intermittency evidence there is, and it
 *    exists nowhere else once the run is over.
 *  - The final result of a flaky test is the *passing* one, so its error is
 *    absent. The error worth reporting comes from the attempt that failed.
 */

// ---------------------------------------------------------------------------
// Source format
//
// Loose objects, not strict: Playwright adds fields between minor versions and
// failing on an addition would be noise. What must fail is a change to a field
// this module reads — those are required below.
// ---------------------------------------------------------------------------

const PlaywrightErrorSchema = z.looseObject({
  message: z.string().optional(),
  stack: z.string().optional(),
  snippet: z.string().optional(),
})

const PlaywrightResultSchema = z.looseObject({
  status: z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']),
  duration: z.number(),
  retry: z.number(),
  error: PlaywrightErrorSchema.optional(),
})

const PlaywrightAnnotationSchema = z.looseObject({
  type: z.string(),
  description: z.string().optional(),
})

const PlaywrightTestSchema = z.looseObject({
  status: z.enum(['expected', 'unexpected', 'flaky', 'skipped']),
  annotations: z.array(PlaywrightAnnotationSchema).default([]),
  results: z.array(PlaywrightResultSchema),
})

const PlaywrightSpecSchema = z.looseObject({
  title: z.string(),
  file: z.string(),
  tests: z.array(PlaywrightTestSchema),
})

/** Suites nest arbitrarily deep; the recursion has to be explicit for Zod. */
export interface PlaywrightSuite {
  title: string
  // Explicit `| undefined` because exactOptionalPropertyTypes is on and Zod's
  // inferred optionals include it; without this the recursive type does not
  // match the schema it describes.
  file?: string | undefined
  specs: z.infer<typeof PlaywrightSpecSchema>[]
  suites?: PlaywrightSuite[] | undefined
}

const PlaywrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() =>
  z.looseObject({
    title: z.string(),
    file: z.string().optional(),
    specs: z.array(PlaywrightSpecSchema),
    suites: z.array(PlaywrightSuiteSchema).optional(),
  }),
)

export const PlaywrightReportSchema = z.looseObject({
  suites: z.array(PlaywrightSuiteSchema),
  stats: z.looseObject({
    startTime: z.string(),
    duration: z.number(),
  }),
})

export type PlaywrightReport = z.infer<typeof PlaywrightReportSchema>

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * `interrupted` maps to `timedOut` rather than `failed`.
 *
 * Both mean the assertion was never reached, which is the distinction the
 * `TestStatus` enum exists to preserve. Mapping it to `failed` would tell the
 * classifier an assertion ran and disagreed, which is not what happened.
 */
const STATUS: Record<z.infer<typeof PlaywrightResultSchema>['status'], TestStatus> = {
  passed: 'passed',
  failed: 'failed',
  timedOut: 'timedOut',
  skipped: 'skipped',
  interrupted: 'timedOut',
}

export interface RunMetadata {
  runId: string
  commitSha: string
  branch: string
}

/**
 * Strip the checkout's absolute path out of free text.
 *
 * Playwright relativises `spec.file`; it does not touch the stack, the snippet
 * or the message, which carry `/Users/someone/work/repo/tests/e2e/…` exactly as
 * the machine saw it. Three consequences, and none of them announces itself:
 *
 * - the text goes into a prompt, and later into a **public** pull-request
 *   comment, carrying somebody's home directory with it;
 * - a fixture captured from a real run is then specific to the machine that
 *   captured it, so two people's fixtures differ by their usernames;
 * - and the golden dataset's leakage lint reads every string in a payload,
 *   where an absolute path is a sentence nobody wrote.
 *
 * The last one is how this was found: the repository's own directory name
 * contains a word from the label vocabulary, and the check fired on a path
 * rather than on prose.
 */
export function relativise(text: string, root: string): string {
  const trimmed = root.replace(/\/+$/, '')
  if (trimmed === '') return text
  return text.replaceAll(`${trimmed}/`, '')
}

/** The title Playwright itself displays: suite path below the file, then the spec. */
const TITLE_SEPARATOR = ' › '

function toError(
  raw: z.infer<typeof PlaywrightErrorSchema> | undefined,
  root: string,
): TestError | undefined {
  if (raw === undefined) return undefined
  const error: TestError = {
    message: relativise(raw.message ?? 'Playwright reported a failure with no message', root),
  }
  if (raw.stack !== undefined) error.stack = relativise(raw.stack, root)
  if (raw.snippet !== undefined) error.snippet = relativise(raw.snippet, root)
  return error
}

function toResult(
  spec: z.infer<typeof PlaywrightSpecSchema>,
  test: z.infer<typeof PlaywrightTestSchema>,
  suitePath: string[],
  root: string,
): TestResult {
  const title = [...suitePath, spec.title].join(TITLE_SEPARATOR)
  const file = normaliseFilePath(spec.file)

  const attempts = test.results
  const last = attempts.at(-1)
  const status: TestStatus = last === undefined ? 'skipped' : STATUS[last.status]

  // A flaky test's final attempt passed, so its error is gone. Report the
  // failure that actually happened.
  const failing = [...attempts].reverse().find((r) => r.error !== undefined)

  const passedAfterFailing =
    status === 'passed' && attempts.some((r) => r.status === 'failed' || r.status === 'timedOut')

  const normalised: TestResult = {
    testId: deriveTestId(file, title),
    title,
    file,
    status,
    attempts: Math.max(attempts.length, 1),
    flakyWithinRun: test.status === 'flaky' || passedAfterFailing,
    durationMs: attempts.reduce((total, r) => total + r.duration, 0),
    annotations: test.annotations.map((a) =>
      a.description === undefined ? a.type : `${a.type}: ${a.description}`,
    ),
  }

  const error = toError(failing?.error, root)
  if (error !== undefined) normalised.error = error

  return normalised
}

function collect(
  suite: PlaywrightSuite,
  suitePath: string[],
  out: TestResult[],
  depth: number,
  root: string,
): void {
  // The outermost suite is the file itself; its title is the filename and would
  // duplicate `file` in every test title.
  const path = depth === 0 ? [] : [...suitePath, suite.title]

  for (const spec of suite.specs) {
    for (const test of spec.tests) out.push(toResult(spec, test, path, root))
  }
  for (const child of suite.suites ?? []) collect(child, path, out, depth + 1, root)
}

/**
 * Validate a Playwright JSON report and normalise it.
 *
 * `meta` is supplied by the caller because the reporter records none of it — the
 * run identity comes from CI, not from the test tool. `repositoryRoot` is
 * optional and, when given, is stripped out of every error's free text — see
 * `relativise` for why that is normalisation rather than editing.
 */
export function normalisePlaywrightReport(
  raw: unknown,
  meta: RunMetadata & { repositoryRoot?: string },
): TestRun {
  const parsed = PlaywrightReportSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Not a Playwright JSON report. The reporter format may have changed:\n${issues}\n` +
        `Update contracts/reporters/playwright.ts and the fixture in tests/fixtures/reporters/.`,
    )
  }

  const results: TestResult[] = []
  const root = meta.repositoryRoot ?? ''
  for (const suite of parsed.data.suites) collect(suite, [], results, 0, root)

  return {
    runId: meta.runId,
    commitSha: meta.commitSha,
    branch: meta.branch,
    startedAt: new Date(parsed.data.stats.startTime).toISOString(),
    durationMs: parsed.data.stats.duration,
    source: 'playwright',
    results,
  }
}
