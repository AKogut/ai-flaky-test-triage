import { defineConfig, devices } from '@playwright/test'
import { originFor, REPO_ROOT, WORKERS } from './tests/e2e/harness.js'

/**
 * Playwright, configured for a suite whose output is data.
 *
 * Most of this file is ordinary. Two settings are not, and both exist because
 * the run feeds a classifier rather than only a red/green light.
 */

/**
 * **Retries are off, and that is the load-bearing decision here.**
 *
 * The conventional setting is `retries: 2` in CI, and it is conventional for a
 * good reason: it keeps a queue moving. It also destroys the only signal this
 * project consumes. A test that fails and then passes is intermittency evidence
 * that exists nowhere else — once the run reports "passed on attempt 2" as a
 * pass, the flakiness has been laundered out of the data before anything can
 * read it, and the pipeline downstream is left classifying failures that
 * survived a filter designed to hide them.
 *
 * So the default run records raw outcomes. Within-run retry information is
 * genuinely useful when it exists — `flakyWithinRun` in the normalised shape is
 * there for it — so retries stay available for a specific investigation:
 *
 * ```sh
 * SENTRA_E2E_RETRIES=3 npm run test:e2e
 * ```
 *
 * That is an opt-in a person types on purpose, not a default that quietly
 * changes what the dataset contains.
 */
const RETRIES = Number(process.env.SENTRA_E2E_RETRIES ?? 0)

/**
 * The specs, named exactly.
 *
 * Anchored to the checkout root rather than written as a relative glob, because
 * a relative glob is not anchored: `tests/e2e/**\/*.spec.ts` matches any path
 * ending that way, including `demo/sources/tests/e2e/smoke.spec.ts` — fixture
 * data that exists to be read as text, not run. It was collected, it failed
 * against an application that is not TaskFlow, and the real suite reported zero
 * tests. A regular expression says what a glob only implies.
 */
const SPECS = new RegExp(
  `^${REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/tests/e2e/[^/]+\\.spec\\.ts$`,
)

/**
 * **No `baseURL` here.** It is a fixture, in `tests/e2e/fixtures.ts`, because
 * each worker has its own server and its own database. A URL set at this level
 * would send every worker to the same instance, and per-test isolation would be
 * a comment rather than a property.
 */
export default defineConfig({
  /**
   * The repository root, with the specs selected by `testMatch` instead.
   *
   * `testDir: 'tests/e2e'` is the obvious setting and it corrupts the pipeline's
   * input. Playwright reports every path relative to the common ancestor of its
   * test directories, so with the specs as the root the JSON report calls this
   * file `reorder-quick-succession.spec.ts` — no directory at all.
   *
   * That matters three ways, and none of them announces itself: `testId` is
   * derived from the path, so two `board.spec.ts` in different directories would
   * share one history; the context assembler reads a test's source from disk by
   * that path and would not find it; and the golden dataset's synthetic fixtures
   * carry repository-relative paths, so captured and synthetic data would differ
   * in shape for a reason that has nothing to do with the failures.
   *
   * The cost is that `testMatch` now selects from the whole tree, and a relative
   * glob is not anchored — `'tests/e2e/**\/*.spec.ts'` also matched
   * `demo/sources/tests/e2e/smoke.spec.ts`, which is fixture data: the contents
   * of specs in an imaginary repository, read as text and fed to a prompt.
   * Playwright collected them, they failed against an application that is not
   * TaskFlow, and the real suite did not run at all. Hence an anchored pattern.
   */
  testDir: '.',
  testMatch: SPECS,

  /**
   * Files are the unit of parallelism; tests inside one run in order, in one
   * worker. `fullyParallel: true` would spread a file's tests across workers and
   * therefore across databases, which reads as isolation and is actually a list
   * of tests that can no longer describe a sequence.
   */
  fullyParallel: false,
  workers: WORKERS,
  retries: RETRIES,

  /** A `test.only` that reaches CI silently shrinks the suite to one test. */
  forbidOnly: process.env.CI !== undefined,

  /**
   * Generous, and deliberately so. A tight timeout turns a slow runner into a
   * failure and puts `environment` in front of a classifier that should have
   * been shown nothing at all — which is the mistake #55 exists to demonstrate,
   * and demonstrating it by accident in the configuration would undercut the
   * point.
   */
  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    // The pipeline's input. Named in .gitignore, in the CI artifact upload, and
    // in docs/architecture.md; `scripts/e2e.ts` validates it against the schema
    // after every run, passing or failing.
    ['json', { outputFile: 'results.json' }],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    /**
     * On failure, and kept. A trace is the evidence the triage agent reads —
     * network timing, the DOM at the moment of the failure, the console — and it
     * is the difference between "the locator matched two elements" and knowing
     * which two. Recording it always would make every run slower for the runs
     * where nothing is wrong.
     */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * One command, which starts one TaskFlow per worker — see `tests/e2e/servers.ts`
   * for why the fleet lives in a single process.
   *
   * The health check names worker 0's port. The launcher binds every port in one
   * synchronous pass, so worker 0 answering means the rest are listening too;
   * checking each would need a URL list this option does not take.
   */
  webServer: {
    command: 'npx tsx tests/e2e/servers.ts',
    url: `${originFor(0)}/api/health`,
    // Locally, a launcher already running is a launcher this run can use. In CI
    // a port that answers is a leftover process, and reusing it would mean
    // testing whatever code that process was started from.
    reuseExistingServer: process.env.CI === undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
})
