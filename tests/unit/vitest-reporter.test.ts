import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { normaliseVitestReport, TestRunSchema, type TestRun } from '@sentra/contracts'
import { UNIT_RESULTS } from '../../vitest.config.js'

/**
 * The unit run really does emit a report the pipeline can read.
 *
 * `tests/unit/reporter-contract.test.ts` checks the *format*, against a fixture
 * captured from a pinned version. This checks the *wiring*, by running the suite
 * for real and normalising whatever comes out — which is a different claim, and
 * the one that broke last time. Two bugs in `npm run dev` survived 1378 passing
 * tests because every test checked the arguments the command would pass and none
 * of them ran it; a reporter configured in a file nobody executes fails exactly
 * the same way, and the symptom is an empty artifact in CI rather than an error.
 *
 * So the child process is given no `--outputFile`, no `--reporter`. It runs the
 * committed configuration, and the assertions are about the file that appears.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const report = join(root, UNIT_RESULTS)

/**
 * The API suite, deliberately named rather than discovered.
 *
 * #49 exists because unit failures are a distribution the golden dataset is
 * missing — far more often `deterministic`, far more often `app_code` — and this
 * file is where those come from. Naming it means renaming it breaks this test,
 * which is the correct outcome.
 */
const SUITE = 'app/server/api.test.ts'

// A child `vitest run` is seconds, not milliseconds, and a cold CI runner is
// slower than that again. Left at the 5s default this becomes a test that fails
// under load — which is #55, and writing it by accident in the file that checks
// the control group would be an embarrassing way to make the point.
vi.setConfig({ testTimeout: 180_000 })

let emitted: unknown
let startedAt = 0

beforeAll(() => {
  // Removed first, so a file left over from an earlier run cannot pass for one
  // this run produced. The parent suite rewrites it on the way out.
  rmSync(report, { force: true })
  startedAt = Date.now()

  execFileSync('npx', ['vitest', 'run', SUITE], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    // `npx` resolves through the repository's own node_modules; the vitest
    // binary is a devDependency and is not assumed to be on PATH.
    env: { ...process.env, CI: '1' },
  })

  emitted = JSON.parse(readFileSync(report, 'utf8'))
})

describe('the configured reporter', () => {
  it('writes the file the configuration names, without being asked on the command line', () => {
    expect(existsSync(report)).toBe(true)
    expect(statSync(report).mtimeMs).toBeGreaterThanOrEqual(startedAt - 1000)
  })

  /**
   * A pipeline output committed by accident is a diff that changes on every run
   * and stops being read within a week — and this one carries absolute paths
   * from whichever machine ran the suite.
   */
  it('writes it somewhere git is told to ignore', () => {
    const ignored = execFileSync('git', ['check-ignore', UNIT_RESULTS], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(ignored.trim()).toBe(UNIT_RESULTS)
  })

  /**
   * Playwright's report is `results.json` and this one is not. `npm test` runs
   * both; sharing a filename would mean whichever finished second silently
   * erased the other's failures, and a lost failure is worse than a loud one.
   */
  it('does not collide with the end-to-end report', () => {
    expect(UNIT_RESULTS).not.toBe('results.json')
  })
})

describe('the report it wrote', () => {
  const meta = { runId: 'run-1', commitSha: 'abc1234', branch: 'main', repositoryRoot: root }
  const run = (): TestRun => normaliseVitestReport(emitted, meta)

  it('normalises without throwing', () => {
    expect(() => run()).not.toThrow()
  })

  it('is a schema-valid TestRun', () => {
    expect(() => TestRunSchema.parse(run())).not.toThrow()
  })

  /** An empty run would satisfy every other assertion in this block. */
  it('carries the tests that actually ran', () => {
    const results = run().results
    expect(results.length).toBeGreaterThan(20)
    expect(results.every((result) => result.file === SUITE)).toBe(true)
  })

  /**
   * Absolute paths are what Vitest reports. An id derived from
   * `/home/runner/work/repo/…` in CI and `/Users/x/repo/…` locally would be two
   * tests with two separate histories, and the flakiness signal would never
   * accumulate for either.
   */
  it('reports repository-relative paths, with the machine stripped out', () => {
    for (const result of run().results) {
      expect(result.file).not.toMatch(/^\/|^[A-Za-z]:/)
      expect(result.testId).not.toContain(root)
    }
  })

  it('gives every test a unique id', () => {
    const ids = run().results.map((result) => result.testId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('says which runner produced it, because the two normalise differently', () => {
    expect(run().source).toBe('vitest')
  })

  /**
   * The suite this run reports on is the control group for the whole project.
   * A flaky unit test here would contaminate the `deterministic` fixtures it is
   * supposed to supply, so the run passing is part of the assertion rather than
   * a precondition somebody checks by eye.
   */
  it('is green, because these are the tests nothing is allowed to be flaky in', () => {
    expect(run().results.filter((result) => result.status !== 'passed')).toEqual([])
  })

  /**
   * A budget, not a measurement. #49 asks for under ten seconds; the suite takes
   * about a quarter of one, so this fires on a change that makes the feedback
   * loop forty times worse and on nothing else. Read against the reported
   * duration rather than the wall clock, so a slow runner's process startup is
   * not counted as the suite being slow.
   */
  it('finishes well inside the budget the milestone set', () => {
    expect(run().durationMs).toBeLessThan(10_000)
  })
})
