import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalisePlaywrightReport,
  parseTestRun,
  type RunMetadata,
  type TestRun,
} from '@sentra/contracts'

/**
 * `npm run test:e2e` — build if needed, run Playwright, then check the report.
 *
 * Three lines of npm script would run Playwright. The two things this adds are
 * both failures that have happened to somebody:
 *
 * **A stale bundle.** The end-to-end suite serves the built client, not the dev
 * server. Editing a component and running the suite without rebuilding tests the
 * previous version — green, and meaningless. The build is cheap and the check is
 * cheaper, so it happens every time rather than being remembered.
 *
 * **A report nobody validated.** `results.json` is the pipeline's input, and the
 * quiet failure mode is a reporter format change that leaves the file parseable
 * and the *content* wrong: every test looks new, the flakiness signal degrades,
 * and nothing anywhere reports an error. Validating after the run costs
 * milliseconds and turns that into a message.
 *
 * The validation runs whether the suite passed or failed. A red suite is exactly
 * when the report matters most, and gating the check on a green run would mean
 * never checking it on the runs that produce data.
 */

const REPO_ROOT = new URL('..', import.meta.url).pathname
const REPORT = 'results.json'
const BUNDLE = 'app/client/dist-bundle'
const CLIENT_SOURCES = 'app/client'

export interface E2eDeps {
  env?: NodeJS.ProcessEnv
  root?: string
  run?: (command: string, args: string[]) => number
  log?: (message: string) => void
  read?: (path: string) => string
  /** Injected so the runner's own tests can use a temporary tree with no specs in it. */
  exists?: (path: string) => boolean
}

/**
 * Newest modification time under a directory, ignoring the build output itself.
 *
 * Comparing against the newest source rather than tracking a hash: the question
 * is only "did anything change after the bundle was written", and an mtime
 * answers it without a cache file that can itself go stale.
 */
export function newestChange(directory: string, ignore: string[] = []): number {
  let newest = 0

  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (ignore.includes(entry.name)) continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else newest = Math.max(newest, statSync(child).mtimeMs)
    }
  }

  walk(directory)
  return newest
}

/** Missing, or older than something it was built from. */
export function isStale(root: string): boolean {
  const index = join(root, BUNDLE, 'index.html')
  if (!existsSync(index)) return true

  const built = statSync(index).mtimeMs
  return newestChange(join(root, CLIENT_SOURCES), ['dist-bundle', 'dist', 'node_modules']) > built
}

/**
 * Who ran this, on what.
 *
 * The reporter records none of it — run identity comes from CI, not from the
 * test tool — so it is assembled here. `unknown` rather than a crash when git is
 * unavailable: a report that says it does not know which commit it describes is
 * more useful than no report, and `TestRun` requires seven characters, which is
 * why the placeholder has seven.
 */
export function metadata(env: NodeJS.ProcessEnv, root: string): RunMetadata {
  const git = (args: string[]): string | null => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    const value = result.stdout?.trim() ?? ''
    return result.status === 0 && value !== '' ? value : null
  }

  return {
    runId: env.GITHUB_RUN_ID ?? `local-${String(process.pid)}`,
    commitSha: env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']) ?? 'unknown',
    branch: env.GITHUB_REF_NAME ?? git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
  }
}

/**
 * Parse the report the way the pipeline will, and say so in one sentence if it
 * cannot. The normaliser's own error already names the field and the file to
 * update; wrapping it in a second message would bury that.
 */
export function validate(raw: unknown, meta: RunMetadata & { repositoryRoot?: string }): TestRun {
  return parseTestRun(normalisePlaywrightReport(raw, meta), REPORT)
}

/**
 * Every reported path must resolve to a file in the checkout.
 *
 * The schema accepts any non-empty string, and the failure this catches passed
 * it comfortably: with `testDir: 'tests/e2e'` Playwright reports paths relative
 * to *that* directory, so the report called a spec
 * `reorder-quick-succession.spec.ts` with no directory at all. Nothing errored.
 * `testId` is derived from the path, so two `board.spec.ts` in different
 * directories would have shared one history; the context assembler reads a
 * test's source from disk by that path and would have found nothing; and the
 * golden dataset's synthetic fixtures carry repository-relative paths, so
 * captured and synthetic fixtures would have differed in shape for a reason
 * that had nothing to do with the failures.
 *
 * Checked against the filesystem rather than against a regular expression,
 * because the question is not whether the string looks like a path.
 */
export function unresolvedPaths(
  run: TestRun,
  root: string,
  exists: (path: string) => boolean = (path) => existsSync(path),
): string[] {
  const files = [...new Set(run.results.map((result) => result.file))]
  return files.filter((file) => !exists(join(root, file)))
}

export function summarise(run: TestRun): string {
  const count = (status: TestRun['results'][number]['status']): number =>
    run.results.filter((result) => result.status === status).length

  const flaky = run.results.filter((result) => result.flakyWithinRun).length
  return [
    `  ${REPORT}: ${String(run.results.length)} tests`,
    `${String(count('passed'))} passed`,
    `${String(count('failed') + count('timedOut'))} failed`,
    `${String(count('skipped'))} skipped`,
    // Zero with retries off is the expected reading, not a surprise. Printed
    // anyway so that a run with SENTRA_E2E_RETRIES set says what it found.
    `${String(flaky)} flaky within the run`,
  ].join(', ')
}

export function main(argv: string[], deps: E2eDeps = {}): number {
  const env = deps.env ?? process.env
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? console.log
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const run =
    deps.run ??
    ((command: string, args: string[]) =>
      spawnSync(command, args, { cwd: root, stdio: 'inherit', env }).status ?? 1)

  if (isStale(root)) {
    log('  The client bundle is missing or older than its sources. Building it first.')
    const built = run('npm', ['run', 'build'])
    if (built !== 0) return built
  }

  const outcome = run('npx', ['playwright', 'test', ...argv])

  let report: unknown
  try {
    report = JSON.parse(read(join(root, REPORT)))
  } catch (failure) {
    console.error(
      `\n  The run produced no readable ${REPORT}, so nothing downstream has anything to read.\n` +
        `  ${failure instanceof Error ? failure.message : String(failure)}\n`,
    )
    return 1
  }

  let outcomeRun: TestRun
  try {
    outcomeRun = validate(report, { ...metadata(env, root), repositoryRoot: root })
  } catch (failure) {
    console.error(
      `\n  ${REPORT} is not something the pipeline can consume:\n\n` +
        `${failure instanceof Error ? failure.message : String(failure)}\n`,
    )
    return 1
  }

  const unresolved = unresolvedPaths(outcomeRun, root, deps.exists ?? existsSync)
  if (unresolved.length > 0) {
    console.error(
      `\n  ${REPORT} reports paths that do not exist in the checkout:\n\n` +
        unresolved.map((file) => `      ${file}`).join('\n') +
        `\n\n  Test identity, run history and the agents' context all key on this path.` +
        `\n  Check \`testDir\` in playwright.config.ts — Playwright reports relative to it.\n`,
    )
    return 1
  }

  log(summarise(outcomeRun))
  return outcome
}

if (process.argv[1]?.endsWith('e2e.ts') === true) {
  process.exitCode = main(process.argv.slice(2))
}
