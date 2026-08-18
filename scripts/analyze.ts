import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  HistoryUnreadableError,
  emptyHistory,
  normalisePlaywrightReport,
  normaliseVitestReport,
  parseTestRun,
  selectForTriage,
  type AnalysedTest,
  type Analysis,
  type History,
  type RunMetadata,
  type TestRun,
} from '@sentra/contracts'
import {
  HISTORY_FILE,
  analyse,
  historyDepth,
  mergeRun,
  readHistory,
  scoreStatusHistory,
  writeHistory,
} from '@sentra/flakemetry'

/**
 * `npm run flakemetry:analyze` — reports plus history in, `analysis.json` out.
 *
 * The statistical half of the pipeline, as one command. Everything it does lives
 * in `flakemetry-lib` already; what is here is the wiring, and three decisions
 * that are not obvious from the library's side.
 *
 * **It writes history only when asked.** ADR-0004 confines writes to `main`, and
 * a default that persists would make every pull-request job contribute its own
 * branch's failures to the history that judges the next one. Read-only is the
 * safe direction for a flag to be forgotten in.
 *
 * **It exits 0 when tests failed.** The command's job is to describe a run, and
 * a run full of failures is the case it exists for. A non-zero exit here would
 * make the pipeline stop exactly where it should be producing its most useful
 * output — and CI already knows the suite went red, from the suite.
 *
 * **It reads both reports and produces one document.** Playwright and Vitest
 * write separate files on purpose: sharing one would have whichever finished
 * second erase the other's failures. They are analysed separately against the
 * same history and their results concatenated, rather than merged into a single
 * `TestRun` first — a merged run would need one value for `source`, and there
 * is no honest one.
 */

const PLAYWRIGHT_REPORT = 'results.json'
const VITEST_REPORT = 'results-unit.json'
const ANALYSIS = 'analysis.json'

export interface AnalyzeOptions {
  reports: string[]
  /** True when the caller named reports itself, so a missing one is an error rather than a skip. */
  explicitReports: boolean
  history: string
  out: string
  writeHistory: boolean
  cap?: number | undefined
  halfLife?: number | undefined
}

export interface AnalyzeDeps {
  env?: NodeJS.ProcessEnv
  root?: string
  read?: (path: string) => string
  write?: (path: string, contents: string) => void
  exists?: (path: string) => boolean
  loadHistory?: (path: string) => History
  saveHistory?: (history: History, path: string) => void
  now?: () => string
  log?: (message: string) => void
}

export function parseArgs(argv: string[]): AnalyzeOptions {
  const reports: string[] = []
  let history = HISTORY_FILE
  let out = ANALYSIS
  let writeHistory = false
  let cap: number | undefined
  let halfLife: number | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]

    if (flag === '--write-history') {
      writeHistory = true
      continue
    }
    // A flag with nothing after it is ignored rather than swallowing the next
    // one, which is how `--out --write-history` silently writes to a file called
    // `--write-history` and skips the history update nobody notices missing.
    if (value === undefined) continue

    if (flag === '--report') reports.push(value)
    else if (flag === '--history') history = value
    else if (flag === '--out') out = value
    else if (flag === '--cap') cap = Number(value)
    else if (flag === '--half-life') halfLife = Number(value)
    else continue
    i += 1
  }

  return {
    reports: reports.length > 0 ? reports : [PLAYWRIGHT_REPORT, VITEST_REPORT],
    explicitReports: reports.length > 0,
    history,
    out,
    writeHistory,
    cap,
    halfLife,
  }
}

/**
 * Which reporter wrote a file, from its shape rather than from its name.
 *
 * Both are `results*.json` and either can be pointed anywhere by a flag, so the
 * filename is a convention and the contents are the fact. Each normaliser
 * already refuses the other's format with a message naming the field that did
 * not match; sniffing first means the caller gets *that* message rather than the
 * wrong reporter's.
 */
export function reporterOf(raw: unknown): 'playwright' | 'vitest' | null {
  if (raw === null || typeof raw !== 'object') return null
  if (Array.isArray((raw as { suites?: unknown }).suites)) return 'playwright'
  if (Array.isArray((raw as { testResults?: unknown }).testResults)) return 'vitest'
  return null
}

/**
 * Identity for a run CI did not give a number to.
 *
 * Derived from the reports rather than from the clock or the process, so
 * analysing the same reports twice is the same run twice. `mergeRun` keys its
 * idempotency on `runId`: with a pid in there, running the command a second time
 * locally appended a second entry for every test and doubled the history, which
 * is exactly the double-counting the run id exists to prevent. In CI the
 * question does not arise, because `GITHUB_RUN_ID` is stable across re-runs —
 * and that is the behaviour local runs should match, not diverge from.
 */
export function localRunId(reports: string[]): string {
  const digest = createHash('sha256')
  for (const contents of reports) digest.update(contents)
  return `local-${digest.digest('hex').slice(0, 12)}`
}

/** Where this run came from. Falls back to git, then to a placeholder that says so. */
export function metadata(env: NodeJS.ProcessEnv, root: string, runId: string): RunMetadata {
  const git = (args: string[]): string | null => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    const value = result.stdout?.trim() ?? ''
    return result.status === 0 && value !== '' ? value : null
  }

  return {
    runId: env.GITHUB_RUN_ID ?? runId,
    commitSha: env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']) ?? 'unknown',
    branch: env.GITHUB_REF_NAME ?? git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
  }
}

/**
 * Test identities used by more than one test in the same run.
 *
 * `deriveTestId` is the file path plus the full title, so two cases with the
 * same name in the same file are one test as far as everything downstream is
 * concerned: they share a row of history, and the last one merged decides what
 * that row says. It is a warning rather than an error because it is the calling
 * repository's test names that cause it, and a pipeline that refuses to run over
 * a suite with two identically-named cases is a pipeline nobody adopts.
 */
export function duplicateIds(runs: TestRun[]): { testId: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const run of runs) {
    for (const result of run.results) {
      counts.set(result.testId, (counts.get(result.testId) ?? 0) + 1)
    }
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([testId, count]) => ({ testId, count }))
    .sort((a, b) => b.count - a.count || a.testId.localeCompare(b.testId))
}

/**
 * Tests that started alternating in this run.
 *
 * Not "everything with a non-zero score", which after a fortnight is most of a
 * real suite and tells a reader nothing they can act on. The question is what
 * *changed*: a test whose recorded history had never alternated, and now has.
 *
 * A retry counts even when the sequence cannot show it — passing on attempt two
 * is the alternation, and it leaves the status history reading `…P`.
 */
export function newlyFlaky(tests: AnalysedTest[]): AnalysedTest[] {
  return tests.filter(({ result, signal }) => {
    const alternatingNow = signal.flakinessScore > 0 || result.flakyWithinRun
    return alternatingNow && scoreStatusHistory(signal.statusHistory.slice(0, -1)) === 0
  })
}

/** One line, because it is read in a CI log beside a hundred others. */
export function summarise(analysis: Analysis): string {
  const failures = analysis.tests.filter(
    (t) => t.result.status === 'failed' || t.result.status === 'timedOut',
  ).length

  return [
    `${String(analysis.tests.length)} tests`,
    `${String(failures)} failing`,
    `${String(newlyFlaky(analysis.tests).length)} newly flaky`,
    `${String(selectForTriage(analysis).length)} to triage`,
    analysis.historyAvailable
      ? `${String(analysis.historyDepth)} runs of history`
      : analysis.historySource === 'unreadable'
        ? 'history unreadable — every test reads as new'
        : 'no history — every test reads as new',
  ].join(', ')
}

export function main(argv: string[], deps: AnalyzeDeps = {}): number {
  const options = parseArgs(argv)
  const env = deps.env ?? process.env
  const root = deps.root ?? process.cwd()
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = deps.exists ?? ((path: string) => existsSync(path))
  const log =
    deps.log ??
    ((message: string) => {
      console.log(message)
    })
  const write =
    deps.write ??
    ((path: string, contents: string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
    })
  const loadHistory = deps.loadHistory ?? readHistory
  const saveHistory = deps.saveHistory ?? writeHistory
  const now = deps.now ?? (() => new Date().toISOString())

  // Every report is read before anything is normalised, because the run's
  // identity is derived from their contents when CI has not supplied one.
  const sources: { path: string; contents: string }[] = []
  for (const path of options.reports) {
    if (!exists(path)) {
      // A default that is not there is a suite that did not run in this job.
      // A path somebody typed is a mistake worth stopping for.
      if (options.explicitReports) {
        console.error(`\n  ${path} does not exist.\n`)
        return 1
      }
      continue
    }
    sources.push({ path, contents: read(path) })
  }

  const meta = {
    ...metadata(env, root, localRunId(sources.map((s) => s.contents))),
    repositoryRoot: root,
  }

  const runs: TestRun[] = []
  for (const { path, contents } of sources) {
    let raw: unknown
    try {
      raw = JSON.parse(contents)
    } catch (error) {
      console.error(`\n  ${path} is not valid JSON: ${(error as Error).message}\n`)
      return 1
    }

    const reporter = reporterOf(raw)
    if (reporter === null) {
      console.error(
        `\n  ${path} is neither a Playwright nor a Vitest JSON report — it has no ` +
          `"suites" and no "testResults".\n`,
      )
      return 1
    }

    try {
      runs.push(
        parseTestRun(
          reporter === 'playwright'
            ? normalisePlaywrightReport(raw, meta)
            : normaliseVitestReport(raw, meta),
          path,
        ),
      )
    } catch (error) {
      console.error(`\n  ${(error as Error).message}\n`)
      return 1
    }
    log(`  read ${path} (${reporter})`)
  }

  if (runs.length === 0) {
    console.error(
      [
        '',
        `  No test report to analyse. Looked for: ${options.reports.join(', ')}`,
        '',
        '  Run the suites first, or name a report with --report <path>.',
        '',
      ].join('\n'),
    )
    return 1
  }

  const duplicates = duplicateIds(runs)
  if (duplicates.length > 0) {
    const extra = duplicates.reduce((total, d) => total + d.count - 1, 0)
    log(
      `  warning: ${String(duplicates.length)} test identities are used by more than one test ` +
        `(${String(extra)} extra results). They share one row of history:`,
    )
    for (const { testId, count } of duplicates.slice(0, 5)) {
      log(`      x${String(count)}  ${testId}`)
    }
    if (duplicates.length > 5) log(`      … and ${String(duplicates.length - 5)} more`)
  }

  let history: History
  let historySource: 'read' | 'missing' | 'unreadable'
  try {
    history = loadHistory(options.history)
    historySource = historyDepth(history) > 0 ? 'read' : 'missing'
  } catch (error) {
    /**
     * A history that cannot be used is not a reason to stop.
     *
     * Cache eviction is an expected operating condition, and so is the corrupt
     * file a killed job used to leave behind. Failing here would turn a cache
     * problem into a red pipeline on a run that has perfectly good reports to
     * describe — and the *worse* outcome is the one this avoids in the other
     * direction: reading a broken file as "no history yet" and producing a
     * confident, thin analysis that says nothing went wrong.
     *
     * Only `HistoryUnreadableError` degrades. A permission error or a full disk
     * is not a cache-shaped problem, and swallowing it would hide a real fault
     * behind a warning nobody reads. That distinction is what `reason` on the
     * error is for.
     */
    if (!(error instanceof HistoryUnreadableError)) {
      console.error(`\n  ${(error as Error).message}\n`)
      return 1
    }
    history = emptyHistory()
    historySource = 'unreadable'
    log('')
    log(`  warning: ${options.history} could not be read (${error.reason}).`)
    log('           Continuing without history: every test reads as new, and')
    log('           determinism falls back to within-run retry evidence alone.')
    if (options.writeHistory) {
      log(`           It will be replaced by this run's history.`)
    }
    log('')
  }

  const scoring = {
    analysedAt: now(),
    ...(options.cap === undefined ? {} : { cap: options.cap }),
    ...(options.halfLife === undefined ? {} : { halfLife: options.halfLife }),
  }

  // Every report is scored against the history as it stood *before* this run, so
  // `isNew` and `historyDepth` describe the run rather than the order the
  // reports happened to be read in.
  const analyses = runs.map((run) => analyse(run, history, scoring))
  const first = analyses[0]
  if (first === undefined) return 1

  const analysis: Analysis = {
    ...first,
    historySource,
    tests: analyses.flatMap((a) => a.tests),
  }

  write(options.out, `${JSON.stringify(analysis, null, 2)}\n`)
  log(`  wrote ${options.out}`)
  log(`  ${summarise(analysis)}`)

  if (options.writeHistory) {
    const merged = runs.reduce(
      (carried, run) =>
        mergeRun(carried, run, options.cap === undefined ? {} : { cap: options.cap }),
      history,
    )
    saveHistory(merged, options.history)
    log(
      `  wrote ${options.history} — ${String(Object.keys(merged.tests).length)} tests, ` +
        `${String(historyDepth(merged))} runs`,
    )
  } else {
    log('  history not written (pass --write-history; ADR-0004 confines that to main)')
  }

  return 0
}

if (process.argv[1]?.endsWith('analyze.ts') === true) {
  process.exitCode = main(process.argv.slice(2))
}
