import { open, titles } from './board.js'
import { expect, test } from './fixtures.js'

/**
 * # The one that never starts. `environment` + `deterministic`.
 *
 * A spec for Safari's engine, on a runner that has never had it. It
 * fails on every run, before the first line of the test body, and nothing
 * about the application or the spec is wrong.
 *
 * ## The mechanism
 *
 * The file asks for WebKit with one line:
 *
 * ```ts
 * test.use({ browserName: 'webkit' })
 * ```
 *
 * That is a legitimate request. Implicit form submission — Enter in a field —
 * is one of the places browsers genuinely differ, `app/client/App.tsx` relies on
 * it for the create form, and Safari is a browser people use.
 *
 * The machine is what cannot honour it. CI installs one browser:
 *
 * ```yaml
 * - run: npx playwright install --with-deps chromium
 * ```
 *
 * and so does the setup this repository documents. Playwright pins an exact
 * build of every browser, so the `browser` fixture looks for that build's
 * executable, does not find it, and fails the test before `page` exists:
 *
 * ```
 * browserType.launch: Executable doesn't exist at …/ms-playwright/webkit-2388/pw_run.sh
 * ```
 *
 * An older WebKit build on the machine does not help — the one this was
 * measured on had three, and the message names the one it wanted.
 *
 * ## Why `environment`, and why not `test_code`
 *
 * Rule 1 in `docs/taxonomy.md` is first, and it fires: the run never reached an
 * assertion. A browser that was never installed is the "missing binary" and
 * "browser launch failure" the rubric names, and the fix is a line in the
 * workflow — install WebKit, or give it a project of its own — not a line here.
 *
 * The tempting alternative is `test_code`, on the grounds that the spec asked
 * for something the project does not configure. But the request is correct,
 * and deleting it would remove the coverage rather than repair it. The rubric
 * decides by where the run broke, and it broke in the runner.
 *
 * ## Why `deterministic`
 *
 * Because no retry downloads a browser. Every attempt of every run fails the
 * same way at the same point. Measured: **9 failures in 9 runs** locally, with
 * Playwright 1.65.1 and no `webkit-2388`. On a machine where somebody ran
 * `npx playwright install` with no arguments it passes — which is exactly why
 * it reads as somebody else's problem. Under the same conditions it fails every
 * time, and that is what the word means.
 *
 * ## Do not fix this by deleting the line
 *
 * The fix is in CI, and applying it means deleting the golden-dataset fixture
 * this file feeds. `scripts/e2e-summary.ts` lists it as failing on every run, and
 * fails the job on the day it passes, so the fix cannot land without somebody
 * noticing.
 */

test.use({ browserName: 'webkit' })

const TITLE = 'Book the retrospective room'

test('adds a task from the keyboard in WebKit', async ({ page }) => {
  await open(page)

  await page.getByPlaceholder('What needs doing?').fill(TITLE)
  await page.getByPlaceholder('What needs doing?').press('Enter')

  await expect(titles(page).last()).toHaveText(TITLE)
})
