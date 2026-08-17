import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fixtureHash,
  normalisePlaywrightReport,
  type FixturePayload,
  type TestResult,
  type TestRun,
} from '@sentra/contracts'
import { scoreStatusHistory } from '@sentra/flakemetry'

/**
 * `npm run capture` — turn real Playwright reports into golden-dataset payloads.
 *
 * The dataset was hand-authored to begin with, and `docs/eval-methodology.md`
 * names that as the sharpest threat to validity the project has: every fixture
 * written by the person who also wrote the rubric and the prompt measures that
 * person's imagination as much as it measures the classifier. #56 is the answer,
 * and this is what makes the answer repeatable instead of a one-off afternoon.
 *
 * ## What it does and does not do
 *
 * It writes **payloads only**. Labels are a separate, deliberate act: you apply
 * the ordered rules in `docs/taxonomy.md`, you write the argument for the label
 * against the tempting alternative, and you do it without looking at what any
 * classifier said. A tool that guessed a label would quietly turn the dataset
 * into a record of what the pipeline already believes.
 *
 * It also refuses to overwrite. A payload edited after a good result is
 * invisible in a diff of numbers, so re-capturing over an existing fixture has
 * to be a deletion first.
 *
 * ## The three rules a captured payload follows
 *
 * They are in `eval/golden-dataset/README.md` in full; two of them are enforced
 * here and the third cannot be:
 *
 * 1. **Paths are relative to the checkout, everywhere.** Playwright relativises
 *    `file` and nothing else; the stack, the snippet and the message keep the
 *    absolute path of whichever machine ran the suite. The report says which
 *    machine in `config.rootDir`, and that is what gets stripped — not the
 *    checkout this command runs in. The two are the same locally and are not the
 *    same for a report downloaded from CI, which is the case that matters and
 *    the one that broke this the first time it was used for real.
 * 2. **Test sources are captured without their comments.** A comment in a spec
 *    is the author's argument about a failure the author understood, and no word
 *    list catches prose.
 * 3. **The history has to come from somewhere real.** `--history` takes a
 *    directory of reports from repeated runs, and the signal is derived from
 *    what those runs actually did. Without it the payload is written with
 *    `historyAvailable: false`, which is honest and much less useful.
 *
 * ## Usage
 *
 * ```sh
 * # One report, no history — the quickest thing that is still true.
 * npm run capture -- --report results.json --test "keeps both moves"
 *
 * # A directory of reports from repeated runs: the history is measured.
 * npm run capture -- --history .sentra/runs --test "keeps both moves"
 *
 * # Everything that failed in a report, one payload each.
 * npm run capture -- --report results.json --all
 * ```
 */

const DATASET_DIR = 'eval/golden-dataset'

export interface CaptureOptions {
  /** A single Playwright JSON report. */
  report?: string
  /** A directory of them, named so they sort in run order. The newest failure is captured. */
  history?: string
  /** Substring of the test title to capture. Ignored when `all` is set. */
  test?: string
  /** Capture every failing test in the report rather than one. */
  all?: boolean
  repositoryRoot?: string
  dir?: string
}

const FLAGS = {
  '--report': 'report',
  '--history': 'history',
  '--test': 'test',
  '--repository-root': 'repositoryRoot',
  '--dir': 'dir',
} as const

export function parseArgs(argv: string[]): CaptureOptions {
  const options: CaptureOptions = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--all') {
      options.all = true
      continue
    }

    const key = FLAGS[arg as keyof typeof FLAGS]
    const value = argv[i + 1]
    if (key !== undefined && value !== undefined) {
      options[key] = value
      i++
    }
  }
  return options
}

/**
 * A name for the fixture, from the failure rather than from the test.
 *
 * Kebab-case, and short. Deliberately *not* the test title: `docs/taxonomy.md`
 * and the dataset README both say a spec is named after behaviour and a fixture
 * after the symptom, and a fixture called `keeps-both-moves` would be named
 * after what the test wanted rather than what happened.
 *
 * The result is a suggestion. It is printed for the author to accept or replace,
 * because the one thing a generated name cannot do is avoid the label
 * vocabulary — a fixture called `flaky-reorder` fails the hygiene lint and is
 * the author's problem, not the tool's.
 */
export function suggestName(result: TestResult): string {
  return `${result.file.split('/').pop() ?? 'spec'}-${result.title}`
    .toLowerCase()
    .replace(/\.spec\.tsx?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '')
}

/** Comments out. See rule 2 above; line comments only when they start the line. */
export function withoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface Signal {
  flakinessScore: number
  consecutiveFailures: number
  totalRuns: number
  statusHistory: string
}

/**
 * A signal from what the runs actually did.
 *
 * `flakinessScore` comes from `@sentra/flakemetry` rather than from a second
 * implementation here. It used to be a local one — the plain share of adjacent
 * runs whose outcome differs — because the real definition did not exist yet,
 * and a fixture scored by a rule production does not use is a fixture that
 * measures the pipeline's inputs instead of the pipeline.
 *
 * The streak is counted over `[FT]` because a timeout is a failure that never
 * reached its assertion, which is the same rule `analyse` applies.
 */
export function signalFrom(history: string): Signal {
  return {
    flakinessScore: scoreStatusHistory(history),
    consecutiveFailures: (/[FT]*$/.exec(history)?.[0] ?? '').length,
    totalRuns: history.length,
    statusHistory: history,
  }
}

const STATUS_LETTER: Record<TestResult['status'], string> = {
  passed: 'P',
  failed: 'F',
  timedOut: 'T',
  skipped: 'S',
}

export interface CaptureDeps {
  read?: (path: string) => string
  list?: (path: string) => string[]
  write?: (path: string, contents: string) => void
  exists?: (path: string) => boolean
  log?: (message: string) => void
  now?: () => string
}

const META = { runId: 'captured', commitSha: '0000000', branch: 'unknown' }

export interface Candidate {
  result: TestResult
  /** Outcomes up to and including the run being captured, oldest first. */
  history: string
  /** When the test was first seen, and when it last passed — from the runs themselves. */
  firstSeenAt: string
  lastPassedAt: string | null
}

/**
 * Every test's most recent failure, with the history that led to it.
 *
 * Not "everything that failed in the newest report", which was the first
 * version and is too narrow to be useful: a suite with five specs that can fail
 * produces a different two or three of them per run, so capturing only the
 * newest means re-running the tool against hand-truncated directories to reach
 * the rest. Taking each test's latest failure gets all of them from one
 * invocation, and the history still stops at the run being captured — a signal
 * that included runs after the failure would be describing a future the
 * classifier could not have seen.
 */
export function latestFailures(runs: TestRun[]): Candidate[] {
  const failed = (result: TestResult): boolean =>
    result.status === 'failed' || result.status === 'timedOut'

  const ids = [...new Set(runs.flatMap((run) => run.results.filter(failed).map((r) => r.testId)))]

  return ids.flatMap((testId) => {
    const seen = runs.map((run) => run.results.find((r) => r.testId === testId))
    const at = seen.findLastIndex((result) => result !== undefined && failed(result))
    const result = seen[at]
    if (result === undefined) return []

    const upTo = seen.slice(0, at + 1)
    const appeared = runs.filter((_run, index) => upTo[index] !== undefined)
    const passed = runs.filter((_run, index) => upTo[index]?.status === 'passed')

    return [
      {
        result,
        history: upTo
          .filter((r): r is TestResult => r !== undefined)
          .map((r) => STATUS_LETTER[r.status])
          .join(''),
        firstSeenAt: appeared[0]?.startedAt ?? runs[0]?.startedAt ?? '',
        lastPassedAt: passed.at(-1)?.startedAt ?? null,
      },
    ]
  })
}

/**
 * The checkout the report was produced in, which is not this one.
 *
 * Playwright records it, and it is the only reliable way to strip a CI runner's
 * absolute paths out of a stack. Falling back to the empty string leaves the
 * text alone rather than guessing, because a wrong prefix would mangle paths
 * instead of shortening them.
 */
export function reportRoot(raw: unknown): string {
  const config = (raw as { config?: { rootDir?: unknown } }).config
  return typeof config?.rootDir === 'string' ? config.rootDir : ''
}

/** Every report in a directory, oldest first, keyed by the numeric part of the filename. */
export function ordered(files: string[]): string[] {
  return files
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => (Number(/\d+/.exec(a)?.[0] ?? 0) || 0) - (Number(/\d+/.exec(b)?.[0] ?? 0) || 0))
}

export function main(argv: string[], deps: CaptureDeps = {}): number {
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const list = deps.list ?? ((path: string) => readdirSync(path))
  const write = deps.write ?? ((path: string, contents: string) => writeFileSync(path, contents))
  const exists = deps.exists ?? ((path: string) => existsSync(path))
  const log = deps.log ?? console.log
  const now = deps.now ?? (() => new Date().toISOString())

  const options = parseArgs(argv)
  const dir = options.dir ?? DATASET_DIR
  // Where test sources are read from — this checkout, not the one that ran the
  // suite. The path to strip out of the error text comes from the report.
  const root = options.repositoryRoot ?? process.cwd()

  if (options.report === undefined && options.history === undefined) {
    console.error(usage())
    return 1
  }
  if (options.test === undefined && options.all !== true) {
    console.error('  Name a test with --test, or pass --all to capture every failure.\n')
    return 1
  }

  const paths =
    options.history !== undefined
      ? ordered(list(options.history)).map((file) => join(options.history ?? '', file))
      : [options.report ?? '']

  const runs: TestRun[] = paths.map((path) => {
    const raw: unknown = JSON.parse(read(path))
    return normalisePlaywrightReport(raw, { ...META, repositoryRoot: reportRoot(raw) })
  })

  if (runs.length === 0) {
    console.error(`  No reports found.\n`)
    return 1
  }

  const wanted = latestFailures(runs).filter(
    (candidate) => options.all === true || candidate.result.title.includes(options.test ?? ''),
  )

  if (wanted.length === 0) {
    const total = runs.at(-1)?.results.length ?? 0
    console.error(
      `\n  Nothing in these ${String(runs.length)} report(s) failed and matched.\n` +
        `  The newest reported ${String(total)} tests.\n`,
    )
    return 1
  }

  for (const { result, history, firstSeenAt, lastPassedAt } of wanted) {
    const name = suggestName(result)
    const file = join(dir, `${name}.run.json`)

    if (exists(file)) {
      console.error(`  ${file} already exists. Delete it first — captures never overwrite.\n`)
      return 1
    }

    const source = join(root, result.file)
    const payload: FixturePayload = {
      name,
      scenario: 'TODO: one sentence, no words from the label vocabulary.',
      subject: {
        result,
        signal: {
          testId: result.testId,
          ...signalFrom(history === '' ? 'F' : history),
          // From the runs, not from the clock: a captured fixture describes when
          // things happened, and `new Date()` would describe when it was filed.
          firstSeenAt: firstSeenAt === '' ? now() : firstSeenAt,
          lastPassedAt,
          isNew: history.length < 2,
        },
      },
      historyAvailable: history.length > 1,
      ...(exists(source) && { testSource: withoutComments(read(source)) }),
    }

    write(file, `${JSON.stringify(payload, null, 2)}\n`)
    log(`  wrote ${file}  (${fixtureHash(payload)})`)
    log(`        history ${history || 'none'}, ${String(runs.length)} report(s)`)
  }

  log(nextSteps(wanted.length))
  return 0
}

const nextSteps = (count: number): string =>
  [
    '',
    `  ${String(count)} payload(s) written. They are not fixtures yet.`,
    '',
    '  1. Replace the TODO scenario. One sentence, and no word from the label',
    '     vocabulary — `npm run eval:lint` checks that and the filename too.',
    '  2. Trim `testSource` to the test and what it calls. The whole file is a',
    '     starting point, not the answer.',
    '  3. Apply the ordered rules in docs/taxonomy.md and write the labels file',
    '     by hand, arguing against the tempting alternative. Do this before',
    '     looking at what any classifier said about it.',
    '  4. `npm run eval:lint`, then `npm run eval` to regenerate the report.',
    '',
  ].join('\n')

const usage = (): string =>
  [
    '',
    '  npm run capture -- --report results.json --test "part of the title"',
    '  npm run capture -- --history <dir of reports> --test "part of the title"',
    '  npm run capture -- --report results.json --all',
    '',
    '  Writes golden-dataset payloads from real Playwright reports. Labels stay',
    '  a hand exercise — see eval/golden-dataset/README.md.',
    '',
  ].join('\n')

if (process.argv[1]?.endsWith('capture.ts') === true) {
  process.exitCode = main(process.argv.slice(2))
}
