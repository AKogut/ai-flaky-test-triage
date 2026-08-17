import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestRun } from '@sentra/contracts'
import { BASE_PORT, databaseFor, originFor, portFor, WORKERS } from '../e2e/harness.js'
import { isStale, main, metadata, newestChange, summarise, validate } from '../../scripts/e2e.js'
import playwright from '../../playwright.config.js'

/**
 * The end-to-end harness, checked without a browser.
 *
 * The suite itself proves the harness works — `npm run test:e2e` starts real
 * servers, drives a real Chromium and validates the report it produces. What
 * that run cannot check cheaply is the behaviour around its edges: a stale
 * bundle, a missing report, a malformed one, a worker count somebody typed
 * wrong. Those are here, where they cost milliseconds.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('which worker gets what', () => {
  it('gives each worker its own port and its own database', () => {
    const ports = new Set<number>()
    const databases = new Set<string>()

    for (let worker = 0; worker < WORKERS; worker++) {
      ports.add(portFor(worker))
      databases.add(databaseFor(worker))
    }

    expect(ports.size).toBe(WORKERS)
    expect(databases.size).toBe(WORKERS)
  })

  it('starts at the documented base port', () => {
    expect(portFor(0)).toBe(BASE_PORT)
    expect(originFor(0)).toBe(`http://127.0.0.1:${String(BASE_PORT)}`)
  })

  /** Under `.playwright/`, which is gitignored — a run must not leave a diff. */
  it('keeps the databases out of the tree git watches', () => {
    expect(databaseFor(1)).toContain('.playwright')
    expect(databaseFor(1)).toMatch(/worker-1\.db$/)
  })

  it('runs more than one worker, because #54 needs the ordering to vary', () => {
    expect(WORKERS).toBeGreaterThan(1)
  })

  /**
   * A malformed override is a typo, and the quiet reading of one — zero workers,
   * or `NaN` ports — is a run that either does nothing or collides with itself.
   */
  it.each(['nought', '0', '-1', '2.5'])('refuses %s as a worker count', async (value) => {
    vi.stubEnv('SENTRA_E2E_WORKERS', value)
    await expect(import('../e2e/harness.js')).rejects.toThrow(/positive whole number/)
  })

  it('takes a whole number when it is given one', async () => {
    vi.stubEnv('SENTRA_E2E_WORKERS', '5')
    vi.stubEnv('SENTRA_E2E_PORT', '5000')
    const harness = await import('../e2e/harness.js')

    expect(harness.WORKERS).toBe(5)
    expect(harness.portFor(4)).toBe(5004)
  })
})

describe('the Playwright configuration', () => {
  /**
   * The setting the whole pipeline rests on. A retry that turns a failure into a
   * pass erases the intermittency this project consumes, and it does it before
   * anything downstream can see the run.
   */
  it('does not retry', () => {
    expect(playwright.retries).toBe(0)
  })

  it('lets an investigation ask for retries explicitly', async () => {
    vi.stubEnv('SENTRA_E2E_RETRIES', '3')
    const reconfigured = (await import('../../playwright.config.js')).default
    expect(reconfigured.retries).toBe(3)
  })

  it('writes the report the pipeline reads, where the pipeline reads it', () => {
    const reporters = playwright.reporter as unknown as [string, Record<string, unknown>?][]
    const json = reporters.find(([name]) => name === 'json')
    expect(json?.[1]).toMatchObject({ outputFile: 'results.json' })
  })

  /** The evidence a triage agent reads. Without it a failure is a message and a guess. */
  it('keeps a trace and a screenshot when something fails', () => {
    expect(playwright.use).toMatchObject({
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
    })
  })

  it('runs chromium', () => {
    expect(playwright.projects?.map((project) => project.name)).toEqual(['chromium'])
  })

  /**
   * `baseURL` belongs to the per-worker fixture. Set here it would point every
   * worker at one server, and the isolation would be a comment.
   */
  it('leaves the base URL to the fixture that knows which worker this is', () => {
    expect((playwright.use as { baseURL?: string }).baseURL).toBeUndefined()
  })

  it('starts one launcher and waits for it to answer', () => {
    const server = playwright.webServer as { command: string; url: string }
    expect(server.command).toContain('tests/e2e/servers.ts')
    expect(server.url).toBe(`${originFor(0)}/api/health`)
  })

  it('keeps a file’s tests in one worker, so a sequence can be a sequence', () => {
    expect(playwright.fullyParallel).toBe(false)
    expect(playwright.workers).toBe(WORKERS)
  })
})

// ---------------------------------------------------------------------------

/** A tree with a bundle and a source, so mtimes can be made to say what is needed. */
function tree(bundleAge: number, sourceAge: number): string {
  const root = mkdtempSync(join(tmpdir(), 'e2e-stale-'))
  mkdirSync(join(root, 'app/client/dist-bundle'), { recursive: true })

  const source = join(root, 'app/client/App.tsx')
  const index = join(root, 'app/client/dist-bundle/index.html')
  writeFileSync(source, 'source')
  writeFileSync(index, '<html></html>')

  const stamp = (path: string, secondsAgo: number): void => {
    const when = new Date(Date.now() - secondsAgo * 1000)
    utimesSync(path, when, when)
  }
  stamp(index, bundleAge)
  stamp(source, sourceAge)
  return root
}

describe('the stale-bundle check', () => {
  /**
   * The end-to-end suite serves the built client. Editing a component and
   * running the suite without rebuilding tests the previous version — green, and
   * meaningless, which is the worst combination a test run can produce.
   */
  it('calls a bundle older than its sources stale', () => {
    expect(isStale(tree(60, 1))).toBe(true)
  })

  it('leaves a bundle newer than its sources alone', () => {
    expect(isStale(tree(1, 60))).toBe(false)
  })

  it('calls a missing bundle stale', () => {
    expect(isStale(mkdtempSync(join(tmpdir(), 'e2e-empty-')) + '/nothing')).toBe(true)
  })

  it('ignores the build output when looking for the newest change', () => {
    const root = tree(1, 60)
    // Something inside dist-bundle is newer than index.html — which is normal,
    // the bundler writes the assets after it. Counting it would make every
    // bundle stale the moment it was built.
    writeFileSync(join(root, 'app/client/dist-bundle/asset.js'), 'built')
    expect(isStale(root)).toBe(false)
  })

  it('finds the newest change at any depth', () => {
    const root = tree(60, 60)
    mkdirSync(join(root, 'app/client/nested/deeper'), { recursive: true })
    writeFileSync(join(root, 'app/client/nested/deeper/late.ts'), 'edited')
    expect(newestChange(join(root, 'app/client'), ['dist-bundle'])).toBeGreaterThan(
      newestChange(join(root, 'app/client/dist-bundle')),
    )
  })
})

describe('the run metadata', () => {
  it('prefers what CI already knows', () => {
    expect(
      metadata({ GITHUB_RUN_ID: '99', GITHUB_SHA: 'abcdef1234', GITHUB_REF_NAME: 'main' }, '.'),
    ).toEqual({ runId: '99', commitSha: 'abcdef1234', branch: 'main' })
  })

  it('falls back to git when it is not in CI', () => {
    const local = metadata({}, process.cwd())
    expect(local.commitSha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(local.branch).not.toBe('')
  })

  /**
   * Seven characters, because `TestRun` requires seven. A report that says it
   * does not know which commit it describes is more useful than no report, but
   * only if it still validates.
   */
  it('says unknown rather than nothing when git is unavailable', () => {
    const nowhere = metadata({}, join(tmpdir(), 'not-a-repository-at-all'))
    expect(nowhere.commitSha.length).toBeGreaterThanOrEqual(7)
  })
})

// ---------------------------------------------------------------------------

const REPORT = {
  stats: { startTime: '2026-01-01T00:00:00.000Z', duration: 1200 },
  suites: [
    {
      title: 'harness.spec.ts',
      file: 'tests/e2e/harness.spec.ts',
      specs: [
        {
          title: 'renders',
          file: 'tests/e2e/harness.spec.ts',
          tests: [
            {
              status: 'expected',
              annotations: [],
              results: [{ status: 'passed', duration: 5, retry: 0 }],
            },
          ],
        },
        {
          title: 'does not',
          file: 'tests/e2e/harness.spec.ts',
          tests: [
            {
              status: 'unexpected',
              annotations: [],
              results: [{ status: 'failed', duration: 7, retry: 0, error: { message: 'boom' } }],
            },
          ],
        },
      ],
    },
  ],
}

const META = { runId: 'run-1', commitSha: 'abc1234', branch: 'main' }

describe('validating the report', () => {
  it('produces a schema-valid TestRun', () => {
    const run = validate(REPORT, META)
    expect(run.source).toBe('playwright')
    expect(run.results.map((result) => result.status)).toEqual(['passed', 'failed'])
  })

  /**
   * The failure this exists for is the quiet one: a reporter renames a field,
   * the file still parses, every test looks new, and the flakiness signal
   * degrades with no error anywhere.
   */
  it('refuses something that is not a Playwright report', () => {
    expect(() => validate({ tests: [] }, META)).toThrow(/Not a Playwright JSON report/)
  })

  it('counts what it found, so a run says something even when it is green', () => {
    expect(summarise(validate(REPORT, META))).toContain('2 tests')
    expect(summarise(validate(REPORT, META))).toContain('1 passed')
    expect(summarise(validate(REPORT, META))).toContain('1 failed')
  })

  it('reports within-run flakiness, which is the only place it survives', () => {
    const flaky: TestRun = { ...validate(REPORT, META) }
    flaky.results = flaky.results.map((result) => ({ ...result, flakyWithinRun: true }))
    expect(summarise(flaky)).toContain('2 flaky within the run')
  })
})

// ---------------------------------------------------------------------------

interface Invocation {
  command: string
  args: string[]
}

const runner = (
  over: { report?: unknown; codes?: Record<string, number>; root?: string } = {},
): { calls: Invocation[]; code: number; output: string } => {
  const calls: Invocation[] = []
  const lines: string[] = []

  const code = main([], {
    env: { GITHUB_RUN_ID: '1', GITHUB_SHA: 'abcdef1', GITHUB_REF_NAME: 'main' },
    root: over.root ?? tree(1, 60),
    log: (message) => lines.push(message),
    read: () => (over.report === undefined ? JSON.stringify(REPORT) : JSON.stringify(over.report)),
    run: (command, args) => {
      calls.push({ command, args })
      return over.codes?.[command] ?? 0
    },
  })

  return { calls, code, output: lines.join('\n') }
}

describe('the runner', () => {
  it('runs Playwright and reports its exit code', () => {
    const { calls, code } = runner()
    expect(calls.map((call) => call.command)).toEqual(['npx'])
    expect(calls[0]?.args.slice(0, 2)).toEqual(['playwright', 'test'])
    expect(code).toBe(0)
  })

  it('builds first when the bundle is stale', () => {
    const { calls } = runner({ root: tree(60, 1) })
    expect(calls.map((call) => call.args[1])).toEqual(['build', 'test'])
  })

  it('does not run the suite when the build fails', () => {
    const { calls, code } = runner({ root: tree(60, 1), codes: { npm: 2 } })
    expect(calls.map((call) => call.command)).toEqual(['npm'])
    expect(code).toBe(2)
  })

  /** A red suite is exactly when the report matters most. */
  it('validates the report even when the suite failed, and still fails', () => {
    const { code, output } = runner({ codes: { npx: 1 } })
    expect(output).toContain('2 tests')
    expect(code).toBe(1)
  })

  it('fails on a report the pipeline could not consume, whatever the suite did', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })

    try {
      expect(runner({ report: { nothing: true } }).code).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('')).toContain('not something the pipeline can consume')
  })

  it('fails when there is no report at all', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const code = main([], {
        env: {},
        root: tree(1, 60),
        log: () => undefined,
        read: () => {
          throw new Error('ENOENT: no such file or directory')
        },
        run: () => 0,
      })
      expect(code).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('passes its arguments through, so `--grep` and `--headed` still work', () => {
    const calls: Invocation[] = []
    main(['--grep', 'reorder'], {
      env: {},
      root: tree(1, 60),
      log: () => undefined,
      read: () => JSON.stringify(REPORT),
      run: (command, args) => {
        calls.push({ command, args })
        return 0
      },
    })
    expect(calls[0]?.args).toEqual(['playwright', 'test', '--grep', 'reorder'])
  })
})
