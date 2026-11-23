import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DELIBERATELY_FLAKY, linker, main } from '../../scripts/e2e-summary.js'

/**
 * The E2E job's verdict, and the list it forgives.
 *
 * The job goes green on a red suite only when every failure is in a spec that
 * fails on purpose, so the two ways this can go wrong are both silent. If the
 * gate is too lenient, a broken runner or a broken control spec ships green,
 * and nothing records that it happened. If the list drifts, the same thing
 * happens more slowly: a spec somebody fixed keeps its exemption, and the next
 * real regression in it is forgiven.
 */

const root = new URL('../..', import.meta.url).pathname
const REPORT_PATH = join(root, 'results.json')

const CONTROL = 'tests/e2e/create.spec.ts'
const OTHER_CONTROL = 'tests/e2e/reorder.spec.ts'
const SPECS = [...DELIBERATELY_FLAKY, CONTROL, OTHER_CONTROL]

type Status = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'

interface Case {
  file: string
  title: string
  results: Status[]
}

/** A Playwright JSON report, shaped as the reporter writes one. */
function report(cases: Case[], extra: Record<string, unknown> = {}): string {
  const files = [...new Set(cases.map((c) => c.file))]
  const testStatus = (results: Status[]): string => {
    const last = results.at(-1)
    if (last === undefined || last === 'skipped') return 'skipped'
    if (last !== 'passed') return 'unexpected'
    return results.length > 1 ? 'flaky' : 'expected'
  }
  return JSON.stringify({
    config: {},
    suites: files.map((file) => ({
      title: file,
      file,
      specs: cases
        .filter((c) => c.file === file)
        .map((c) => ({
          title: c.title,
          file,
          tests: [
            {
              status: testStatus(c.results),
              annotations: [],
              results: c.results.map((status, retry) => ({ status, duration: 5, retry })),
            },
          ],
        })),
    })),
    errors: [],
    stats: { startTime: '2026-11-23T11:35:21.598Z', duration: 1000 },
    ...extra,
  })
}

/** Every spec passing once, with `overrides` replacing or adding cases. */
const green = (...overrides: Case[]): Case[] => [
  ...SPECS.filter((file) => !overrides.some((c) => c.file === file)).map((file) => ({
    file,
    title: `passes in ${basename(file)}`,
    results: ['passed'] as Status[],
  })),
  ...overrides,
]

interface Run {
  code: number
  printed: string[]
  summary: string
  notices: string[]
  errors: string[]
}

function run(
  options: { report?: string | undefined; exitCode?: string; env?: NodeJS.ProcessEnv } = {},
): Run {
  const printed: string[] = []
  let summary = ''
  const text = 'report' in options ? options.report : report(green())
  const code = main([], {
    root,
    env: {
      GITHUB_RUN_ID: '1',
      GITHUB_SHA: 'abcdef1234567',
      GITHUB_REF_NAME: 'main',
      GITHUB_STEP_SUMMARY: '/summary.md',
      ...(options.exitCode === undefined ? {} : { E2E_EXIT_CODE: options.exitCode }),
      ...options.env,
    },
    exists: (path) => (path === REPORT_PATH ? text !== undefined : existsSync(path)),
    read: () => text ?? '',
    specs: () => SPECS,
    print: (line) => printed.push(line),
    append: (_path, markdown) => (summary += markdown),
  })
  return {
    code,
    printed,
    summary,
    notices: printed.filter((line) => line.startsWith('::notice')),
    errors: printed.filter((line) => line.startsWith('::error')),
  }
}

describe('a red suite made only of the deliberate failures', () => {
  const failing = green(
    { file: 'tests/e2e/find-by-name.spec.ts', title: 'finds a new task', results: ['failed'] },
    {
      file: 'tests/e2e/reorder-quick-succession.spec.ts',
      title: 'keeps both moves',
      results: ['timedOut'],
    },
  )
  const result = run({ report: report(failing), exitCode: '1' })

  it('passes the job', () => {
    expect(result.code).toBe(0)
  })

  it('says so with exactly one notice, carrying the counts, and no error or warning', () => {
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toContain('6 tests: 4 passed, 2 failed, 0 flaky, 0 skipped')
    expect(result.errors).toEqual([])
    expect(result.printed.filter((line) => line.startsWith('::warning'))).toEqual([])
  })

  it('writes the counts and each failing test, with its file, to the job summary', () => {
    expect(result.summary).toContain('| Passed | Failed | Flaky | Skipped |')
    expect(result.summary).toContain('| 4 | 2 | 0 | 0 |')
    expect(result.summary).toContain('| finds a new task | `tests/e2e/find-by-name.spec.ts` |')
    expect(result.summary).toContain(
      '| keeps both moves | `tests/e2e/reorder-quick-succession.spec.ts` | timed out, expected |',
    )
  })

  it('says the failures are expected and where they go', () => {
    expect(result.summary).toMatch(/fail intermittently by design/)
    expect(result.summary).toContain('**Flakiness analysis**')
    expect(result.summary).toContain('**Agent triage**')
  })

  it('writes the summary to $GITHUB_STEP_SUMMARY rather than the log', () => {
    expect(result.printed.some((line) => line.includes('| Passed |'))).toBe(false)
  })
})

describe('a green suite', () => {
  const result = run({ exitCode: '0' })

  it('passes, with one notice and no failing-test table', () => {
    expect(result.code).toBe(0)
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toContain('Nothing failed.')
    expect(result.summary).toContain('**Passed.** Nothing failed.')
    expect(result.summary).not.toContain('| Failing test |')
  })
})

describe('a genuinely broken suite is loud', () => {
  const failsWith = (result: Run, pattern: RegExp): void => {
    expect(result.code).toBe(1)
    expect(result.notices).toEqual([])
    expect(result.errors.some((line) => pattern.test(line))).toBe(true)
    expect(result.summary).toContain('**Failed.**')
  }

  it('when a control spec fails, naming the file so the annotation links to it', () => {
    const result = run({
      report: report(green({ file: CONTROL, title: 'adds a task', results: ['failed'] })),
      exitCode: '1',
    })
    failsWith(result, /^::error file=tests\/e2e\/create\.spec\.ts,title=Unexpected E2E failure/)
    expect(result.summary).toContain('failed, **unexpected**')
  })

  it('when a control spec fails even though the deliberate ones failed too', () => {
    const result = run({
      report: report(
        green(
          { file: 'tests/e2e/find-by-name.spec.ts', title: 'finds', results: ['failed'] },
          { file: OTHER_CONTROL, title: 'moves a task', results: ['timedOut'] },
        ),
      ),
      exitCode: '1',
    })
    failsWith(result, /reorder\.spec\.ts/)
    expect(result.errors).toHaveLength(1)
  })

  /**
   * Retries are off in CI, so this only happens when somebody turns them on.
   * A control spec that needed a second attempt still failed once, and the
   * control group is only worth anything if it never does.
   */
  it('when a control spec passes only on a retry', () => {
    const result = run({
      report: report(green({ file: CONTROL, title: 'adds', results: ['failed', 'passed'] })),
      exitCode: '0',
    })
    failsWith(result, /adds \(flaky\)/)
  })

  it('when results.json was never written', () => {
    failsWith(run({ report: undefined, exitCode: '1' }), /results\.json was never written/)
  })

  it('when results.json is not JSON', () => {
    failsWith(run({ report: '{"suites": [', exitCode: '1' }), /results\.json is not JSON/)
  })

  it('when results.json is not a Playwright report', () => {
    failsWith(
      run({ report: JSON.stringify({ numTotalTests: 3 }), exitCode: '1' }),
      /not a report the pipeline can read/,
    )
  })

  it('when the report names a file that is not in the checkout', () => {
    const result = run({
      report: report(green({ file: 'tests/e2e/gone.spec.ts', title: 'x', results: ['passed'] })),
      exitCode: '1',
    })
    failsWith(result, /not in the checkout: tests\/e2e\/gone\.spec\.ts/)
  })

  it('when Playwright reports an error outside any test, such as a server that never started', () => {
    const result = run({
      report: report(green(), {
        errors: [{ message: '\u001b[31mError: Timed out waiting 60000ms from config.webServer.' }],
      }),
      exitCode: '1',
    })
    failsWith(result, /outside any test: Error: Timed out waiting 60000ms/)
    expect(result.errors.join('\n')).not.toContain('\u001b')
  })

  it('when no test ran at all', () => {
    failsWith(run({ report: report([]), exitCode: '1' }), /No test ran/)
  })

  it('when every test was skipped or never started', () => {
    const skipped = SPECS.map((file) => ({ file, title: 'never', results: [] as Status[] }))
    failsWith(run({ report: report(skipped), exitCode: '1' }), /No test ran/)
  })

  it('when a spec on disk never ran', () => {
    const result = run({
      report: report(green().filter((c) => c.file !== OTHER_CONTROL)),
      exitCode: '0',
    })
    failsWith(result, /never ran: tests\/e2e\/reorder\.spec\.ts/)
  })

  /** e2e.ts exits 1 for an unusable report too; with no failed test, that is the only explanation left. */
  it('when the runner exited non-zero and no test failed', () => {
    failsWith(run({ exitCode: '1' }), /exited 1, but results\.json records no failed test/)
  })

  it('when the exit status it was handed is not one', () => {
    failsWith(run({ exitCode: 'failure' }), /E2E_EXIT_CODE is not an exit status/)
  })
})

describe('untrusted text', () => {
  /** A fork controls test titles. A newline must not start a workflow command of its own. */
  it('escapes titles in annotations and in the table', () => {
    const title = 'a | b <b>\n::error::injected 100%'
    const result = run({
      report: report(green({ file: CONTROL, title, results: ['failed'] })),
      exitCode: '1',
    })
    expect(result.printed.filter((line) => line.startsWith('::error::injected'))).toEqual([])
    expect(result.errors[0]).toContain('%0A::error::injected 100%25')
    expect(result.summary).toContain('| a \\| b &lt;b&gt; ::error::injected 100% |')
  })
})

describe('the specs it expects to see', () => {
  /** Without an injected list it reads `tests/e2e/`, which is what Playwright collects from. */
  it('are every spec file in tests/e2e', () => {
    const tracked = execSync('git ls-files "tests/e2e/*.spec.ts"', { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((path) => path !== '')
    const all = tracked.map((file) => ({ file, title: 'passes', results: ['passed'] as Status[] }))
    const printed: string[] = []
    const judgeWithout = (cases: Case[]): number =>
      main([], {
        root,
        env: {
          GITHUB_SHA: 'abcdef1234567',
          GITHUB_STEP_SUMMARY: '/summary.md',
          E2E_EXIT_CODE: '0',
        },
        exists: (path) => path === REPORT_PATH || existsSync(path),
        read: () => report(cases),
        print: (line) => printed.push(line),
        append: () => undefined,
      })

    expect(judgeWithout(all)).toBe(0)
    expect(judgeWithout(all.slice(1))).toBe(1)
    expect(printed.join('\n')).toContain(`never ran: ${tracked[0] ?? ''}.`)
  })
})

describe('outside CI', () => {
  it('prints the summary when there is no $GITHUB_STEP_SUMMARY to append to', () => {
    const result = run({ exitCode: '0', env: { GITHUB_STEP_SUMMARY: '' } })
    expect(result.printed.some((line) => line.includes('| Passed |'))).toBe(true)
  })

  it('links files to the commit on GitHub, and leaves them as code elsewhere', () => {
    expect(linker({})(CONTROL)).toBe('`tests/e2e/create.spec.ts`')
    expect(
      linker({
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_SHA: 'abc1234',
      })(CONTROL),
    ).toBe(
      '[`tests/e2e/create.spec.ts`](https://github.com/owner/repo/blob/abc1234/tests/e2e/create.spec.ts)',
    )
  })
})

// ---------------------------------------------------------------------------
// The list, against the specs
// ---------------------------------------------------------------------------

/** Comments removed, as `e2e-standards.test.ts` does, so prose cannot satisfy a check on code. */
const code = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

const specFiles = execSync('git ls-files "tests/e2e/*.spec.ts"', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((path) => path !== '')
  .map((path) => {
    const raw = readFileSync(join(root, path), 'utf8')
    return { path, header: /\/\*\*[\s\S]*?\*\//.exec(raw)?.[0] ?? '', source: code(raw) }
  })

/**
 * Whether a spec steps outside the environment the control group runs in, for
 * the whole file. There are two ways to, each one visible line (see
 * `tests/e2e/fixtures.ts`): the chaotic server, and a database that is not
 * reset between tests. Indented calls inside a `describe` are a block, not the
 * file, and `harness.spec.ts` uses one to prove the opt-out works.
 */
const fileLevel = (source: string, option: RegExp): boolean =>
  new RegExp(`^test\\.use\\(\\{[^}]*\\b${option.source}`, 'm').test(source)

const CHAOS = /chaos:\s*true/
const NO_RESET = /resetDatabase:\s*false/

const optedIn = (option: RegExp): string[] =>
  specFiles.filter((spec) => fileLevel(spec.source, option)).map((spec) => spec.path)

/**
 * The cause half of the cross-test leak. It leaves a row behind and never reads
 * one, so nothing in it fails, and its header names the spec where the leak
 * shows up instead.
 */
const CAUSES: Record<string, string> = {
  'tests/e2e/quarterly-pack.spec.ts': 'tests/e2e/visible-tasks.spec.ts',
}

describe('the deliberately flaky specs', () => {
  it('are found, so the checks below are checking something', () => {
    expect(specFiles.length).toBeGreaterThan(DELIBERATELY_FLAKY.length)
    expect(optedIn(CHAOS).length).toBeGreaterThan(0)
    expect(optedIn(NO_RESET).length).toBeGreaterThan(0)
  })

  it('name only spec files git tracks, each once', () => {
    const tracked = specFiles.map((spec) => spec.path)
    for (const file of DELIBERATELY_FLAKY) expect(tracked).toContain(file)
    expect(new Set(DELIBERATELY_FLAKY).size).toBe(DELIBERATELY_FLAKY.length)
  })

  /**
   * A listed spec that runs in the controlled environment cannot fail on
   * purpose any more. Somebody applied the fix its header describes, and the
   * entry is now a standing exemption for a real regression.
   */
  it.each(DELIBERATELY_FLAKY)('%s steps outside the controlled environment', (file) => {
    const spec = specFiles.find((s) => s.path === file)
    expect(fileLevel(spec?.source ?? '', CHAOS) || fileLevel(spec?.source ?? '', NO_RESET)).toBe(
      true,
    )
  })

  it.each(DELIBERATELY_FLAKY)('%s says in its opening comment that it fails', (file) => {
    const header = specFiles.find((s) => s.path === file)?.header ?? ''
    expect(header).toMatch(/\bfails\b/)
    expect(header).toMatch(/\bintermittent\b/)
  })

  /** The chaotic server exists for these specs and nothing else (`tests/e2e/harness.ts`). */
  it('include every spec that runs against the chaotic server', () => {
    expect(DELIBERATELY_FLAKY).toEqual(expect.arrayContaining(optedIn(CHAOS)))
  })

  it('include every spec that keeps rows another file left, except where the rows come from', () => {
    const unlisted = optedIn(NO_RESET).filter((file) => !DELIBERATELY_FLAKY.includes(file))
    expect(unlisted).toEqual(Object.keys(CAUSES))
  })

  it.each(Object.entries(CAUSES))('%s fails nowhere itself, and names %s', (cause, symptom) => {
    const header = specFiles.find((s) => s.path === cause)?.header ?? ''
    expect(header).toContain('Nothing in this file fails.')
    expect(header).toContain(`\`${basename(symptom)}\``)
    expect(DELIBERATELY_FLAKY).toContain(symptom)
  })
})
