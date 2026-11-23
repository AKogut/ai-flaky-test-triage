import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import type { RunMetadata, TestResult, TestRun } from '@sentra/contracts'
import { metadata, unresolvedPaths, validate } from './e2e.js'

/**
 * `npx tsx scripts/e2e-summary.ts` — the E2E job's verdict on its own run.
 *
 * The suite is red on most runs, and on purpose. A few specs fail some of the
 * time by design, because their failures are what the `Flakiness analysis` and
 * `Agent triage` jobs exist to classify. So "the suite exited 1" says nothing
 * on its own. It is the normal case, and it is also what a crashed runner, a
 * report nobody wrote and a broken control spec look like.
 *
 * This reads the report and tells those apart. The job summary gets a table of
 * the run. The Actions UI gets one `::notice` with the counts when every
 * failure is one of the deliberate ones, and an `::error` for anything else,
 * with a non-zero exit so the job goes red.
 *
 * It parses the report the way `npm run test:e2e` validates it, through the
 * same `validate` and `unresolvedPaths`. The runner exits 1 both when tests
 * fail and when its report is unusable. This is the step that has to tell
 * those two apart, so it cannot trust the exit status to do it.
 */

const REPO_ROOT = new URL('..', import.meta.url).pathname
const REPORT = 'results.json'

/** Where Playwright collects specs from: `testMatch` in playwright.config.ts, top level only. */
const SPEC_DIR = 'tests/e2e'

/**
 * The specs that fail some of the time on purpose. Each one's opening comment
 * says how and why.
 *
 * A list, written down, rather than something read out of the specs at run
 * time. This is the gate that decides whether a red suite fails the job, and a
 * gate that parses prose fails open the day somebody rewords a header. The
 * cost of a list is drift. `tests/unit/e2e-summary.test.ts` holds it against
 * the spec files from both sides. An entry must still step outside the
 * controlled environment the control group runs in (a chaotic server, or a
 * database that is not reset), and every spec that does so must be here.
 *
 * Per file, not per test, because that is the level the headers describe.
 * `board-updates.spec.ts` and `visible-tasks.spec.ts` each hold one test that
 * should pass every run, and this forgives those too. A regression that breaks
 * one of them will almost always break a control spec as well, and the control
 * specs are not forgiven.
 */
export const DELIBERATELY_FLAKY: readonly string[] = [
  'tests/e2e/board-updates.spec.ts',
  'tests/e2e/find-by-name.spec.ts',
  'tests/e2e/reorder-quick-succession.spec.ts',
  'tests/e2e/visible-tasks.spec.ts',
]

export interface Counts {
  passed: number
  failed: number
  /** Failed, then passed on a retry. Zero unless `SENTRA_E2E_RETRIES` is set. */
  flaky: number
  skipped: number
}

export interface Failure {
  title: string
  file: string
  outcome: 'failed' | 'timed out' | 'flaky'
  /** In one of {@link DELIBERATELY_FLAKY}. */
  deliberate: boolean
}

export interface Verdict {
  /** Absent when there was no readable report to count. */
  counts?: Counts
  failures: Failure[]
  /** Reasons the run cannot be taken at its word. Any entry fails the job. */
  problems: string[]
}

export interface JudgeInput {
  /** The report's text, or `undefined` when the file was never written. */
  report: string | undefined
  /** `npm run test:e2e`'s exit status as the workflow passed it. Empty or absent when unknown. */
  exitCode: string | undefined
  /** Every spec file the run should have reported on. */
  specs: string[]
  meta: RunMetadata & { repositoryRoot: string }
  exists: (path: string) => boolean
}

/** Every test counted once. A test that failed and then passed is `flaky`, not `passed`. */
export function count(run: TestRun): Counts {
  const counts: Counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 }
  for (const result of run.results) {
    if (result.status === 'skipped') counts.skipped += 1
    else if (result.status !== 'passed') counts.failed += 1
    else if (result.flakyWithinRun) counts.flaky += 1
    else counts.passed += 1
  }
  return counts
}

function failureOf(result: TestResult, deliberate: ReadonlySet<string>): Failure | undefined {
  const outcome =
    result.status === 'failed'
      ? 'failed'
      : result.status === 'timedOut'
        ? 'timed out'
        : result.status === 'passed' && result.flakyWithinRun
          ? 'flaky'
          : undefined
  if (outcome === undefined) return undefined
  return {
    title: result.title,
    file: result.file,
    outcome,
    deliberate: deliberate.has(result.file),
  }
}

const messageOf = (failure: unknown): string =>
  stripVTControlCharacters(failure instanceof Error ? failure.message : String(failure)).trim()

const GlobalErrorsSchema = z.looseObject({
  errors: z.array(z.looseObject({ message: z.string().optional() })).default([]),
})

/**
 * Errors Playwright raised outside any test: a web server that never answered,
 * a spec that did not compile, the global timeout. A healthy run has none. Each
 * one means some tests may never have run, and the report cannot show which.
 */
function globalErrors(raw: unknown): string[] {
  const parsed = GlobalErrorsSchema.safeParse(raw)
  if (!parsed.success) return [`${REPORT} has an \`errors\` field that is not a list of errors.`]
  return parsed.data.errors.map((error) => {
    const message = messageOf(error.message ?? 'no message')
    return `Playwright reported an error outside any test: ${message.split('\n')[0] ?? message}`
  })
}

export function judge(input: JudgeInput): Verdict {
  const problems: string[] = []

  const exitCode = input.exitCode?.trim() ?? ''
  if (exitCode !== '' && !/^\d+$/.test(exitCode)) {
    problems.push(`E2E_EXIT_CODE is not an exit status: ${JSON.stringify(input.exitCode)}.`)
  }

  if (input.report === undefined) {
    problems.push(
      `${REPORT} was never written, so the runner stopped before Playwright reported anything. ` +
        `Read the "Run Playwright" step.`,
    )
    return { failures: [], problems }
  }

  let raw: unknown
  try {
    raw = JSON.parse(input.report)
  } catch (failure) {
    problems.push(`${REPORT} is not JSON: ${messageOf(failure)}`)
    return { failures: [], problems }
  }

  let run: TestRun
  try {
    run = validate(raw, input.meta)
  } catch (failure) {
    problems.push(`${REPORT} is not a report the pipeline can read. ${messageOf(failure)}`)
    return { failures: [], problems }
  }

  const unresolved = unresolvedPaths(run, input.meta.repositoryRoot, input.exists)
  if (unresolved.length > 0) {
    problems.push(
      `${REPORT} names files that are not in the checkout: ${unresolved.join(', ')}. ` +
        `Check \`testDir\` in playwright.config.ts.`,
    )
  }

  problems.push(...globalErrors(raw))

  // A spec that never ran cannot fail. That is how the suite once reported zero
  // tests and passed (see `testMatch` in playwright.config.ts).
  const reported = new Set(run.results.map((result) => result.file))
  const missing = input.specs.filter((spec) => !reported.has(spec))
  if (missing.length > 0) {
    problems.push(`These specs are not in ${REPORT}, so they never ran: ${missing.join(', ')}.`)
  }

  const counts = count(run)
  if (counts.passed + counts.failed + counts.flaky === 0) {
    problems.push(
      `No test ran. ${REPORT} lists ${String(run.results.length)}, and none of them started.`,
    )
  }

  const deliberate = new Set(DELIBERATELY_FLAKY)
  const failures = run.results.flatMap((result) => failureOf(result, deliberate) ?? [])

  if (exitCode !== '' && exitCode !== '0' && failures.length === 0) {
    problems.push(
      `npm run test:e2e exited ${exitCode}, but ${REPORT} records no failed test, so something ` +
        `other than a test failed. Read the "Run Playwright" step.`,
    )
  }

  return { counts, failures, problems }
}

/** The job fails on a problem, or on a failure outside the deliberately flaky specs. */
export const passes = (verdict: Verdict): boolean =>
  verdict.problems.length === 0 && verdict.failures.every((failure) => failure.deliberate)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Workflow-command escaping, as `@actions/core` does it. A newline in a title must not start a command. */
const escapeData = (text: string): string =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')

const escapeProperty = (text: string): string =>
  escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C')

/** One table cell. Test titles come from spec source, which a fork controls. */
const cell = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll(/\s+/g, ' ')
    .trim()

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`

/** The workflow commands for the Actions UI. Exactly one `::notice` when the job passes. */
export function annotations(verdict: Verdict): string[] {
  if (passes(verdict) && verdict.counts !== undefined) {
    const { passed, failed, flaky, skipped } = verdict.counts
    const total = passed + failed + flaky + skipped
    const tail =
      failed + flaky === 0
        ? 'Nothing failed.'
        : 'Every failure is in a spec that fails intermittently by design, and goes to Flakiness analysis and Agent triage.'
    return [
      `::notice title=E2E tests::${escapeData(
        `${plural(total, 'test')}: ${String(passed)} passed, ${String(failed)} failed, ` +
          `${String(flaky)} flaky, ${String(skipped)} skipped. ${tail}`,
      )}`,
    ]
  }

  return [
    ...verdict.problems.map((problem) => `::error title=E2E tests::${escapeData(problem)}`),
    ...verdict.failures
      .filter((failure) => !failure.deliberate)
      .map(
        (failure) =>
          `::error file=${escapeProperty(failure.file)},title=${escapeProperty(
            `Unexpected E2E failure: ${failure.title}`,
          )}::${escapeData(
            `${failure.title} (${failure.outcome}). ${failure.file} is not one of the specs ` +
              `that fail on purpose, so this is a real failure.`,
          )}`,
      ),
  ]
}

/** `[`file`](link)` on GitHub, where the run says which commit it was; plain code elsewhere. */
export function linker(env: NodeJS.ProcessEnv): (file: string) => string {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = env
  if (server === undefined || repo === undefined || sha === undefined)
    return (file) => `\`${file}\``
  return (file) => `[\`${file}\`](${server}/${repo}/blob/${sha}/${file})`
}

/** The Markdown for `$GITHUB_STEP_SUMMARY`. */
export function render(verdict: Verdict, link: (file: string) => string): string {
  const lines = ['## E2E tests', '']
  const unexpected = verdict.failures.filter((failure) => !failure.deliberate)

  if (passes(verdict)) {
    const failed = verdict.failures.length
    lines.push(
      failed === 0
        ? '**Passed.** Nothing failed.'
        : failed === 1
          ? '**Passed.** 1 test failed, in a spec that fails on purpose.'
          : `**Passed.** ${String(failed)} tests failed, all in specs that fail on purpose.`,
    )
  } else {
    lines.push('**Failed.** Something went wrong that is not one of the deliberate failures:', '')
    for (const problem of verdict.problems) lines.push(`- ${cell(problem)}`)
    for (const failure of unexpected) {
      lines.push(`- ${cell(failure.title)} (${link(failure.file)}): ${failure.outcome}.`)
    }
  }
  lines.push('')

  if (verdict.counts !== undefined) {
    const { passed, failed, flaky, skipped } = verdict.counts
    lines.push(
      '| Passed | Failed | Flaky | Skipped |',
      '| -----: | -----: | ----: | ------: |',
      `| ${String(passed)} | ${String(failed)} | ${String(flaky)} | ${String(skipped)} |`,
      '',
    )
  }

  if (verdict.failures.length > 0) {
    lines.push('| Failing test | File | Outcome |', '| --- | --- | --- |')
    for (const failure of verdict.failures) {
      const why = failure.deliberate ? 'expected' : '**unexpected**'
      lines.push(`| ${cell(failure.title)} | ${link(failure.file)} | ${failure.outcome}, ${why} |`)
    }
    lines.push('')
  }

  lines.push(
    `These specs fail intermittently by design: ${DELIBERATELY_FLAKY.map(link).join(', ')}. ` +
      'Their failures are expected and are passed to the **Flakiness analysis** and ' +
      '**Agent triage** jobs to classify. A failure anywhere else fails this job.',
    '',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SummaryDeps {
  env?: NodeJS.ProcessEnv
  root?: string
  exists?: (path: string) => boolean
  read?: (path: string) => string
  /** The spec files Playwright should have collected, repository-relative. */
  specs?: () => string[]
  print?: (line: string) => void
  append?: (path: string, text: string) => void
}

/** `argv[0]`, when given, is the report to read instead of `results.json` at the root. */
export function main(argv: string[], deps: SummaryDeps = {}): number {
  const env = deps.env ?? process.env
  const root = deps.root ?? REPO_ROOT
  const exists = deps.exists ?? existsSync
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const print = deps.print ?? console.log
  const append = deps.append ?? appendFileSync
  const specs =
    deps.specs ??
    (() =>
      readdirSync(join(root, SPEC_DIR))
        .filter((name) => name.endsWith('.spec.ts'))
        .map((name) => `${SPEC_DIR}/${name}`))

  const path = argv[0] ?? join(root, REPORT)
  const verdict = judge({
    report: exists(path) ? read(path) : undefined,
    exitCode: env.E2E_EXIT_CODE,
    specs: specs(),
    meta: { ...metadata(env, root), repositoryRoot: root },
    exists,
  })

  const markdown = render(verdict, linker(env))
  const summary = env.GITHUB_STEP_SUMMARY
  if (summary === undefined || summary === '') print(markdown)
  else append(summary, `${markdown}\n`)

  for (const line of annotations(verdict)) print(line)
  return passes(verdict) ? 0 : 1
}

if (process.argv[1]?.endsWith('e2e-summary.ts') === true) {
  process.exitCode = main(process.argv.slice(2))
}
