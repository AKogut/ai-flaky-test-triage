import type { Page } from '@playwright/test'
import { SEED } from '@sentra/taskflow-server'
import { expect, stored, test } from './fixtures.js'

/**
 * The harness itself, before any spec relies on it.
 *
 * Isolation is the kind of property that fails silently: nothing errors, tests
 * simply begin to depend on each other, and the bill arrives months later as an
 * ordering-dependent flake in the suite that is supposed to be the control group.
 * So the fixture's two promises — a server of your own, a list that starts from
 * the seed — are asserted here rather than assumed by the two hundred assertions
 * that come after them.
 *
 * The flows themselves are #51. Nothing here is a test of TaskFlow.
 */

const NEW_TASK = 'What needs doing?'

const add = async (page: Page, title: string): Promise<void> => {
  await page.getByPlaceholder(NEW_TASK).fill(title)
  await page.getByRole('button', { name: 'Add task' }).click()
}

test.describe('one TaskFlow per worker', () => {
  test('serves the built client from the same origin as the API', async ({ page, taskflow }) => {
    const response = await page.goto('/')

    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'TaskFlow' })).toBeVisible()

    // Same origin is the whole reason the server serves the bundle: no proxy, no
    // CORS layer, nothing between the page and the API to rule out.
    expect(new URL(page.url()).origin).toBe(taskflow.origin)
  })

  test('answers the API from that origin too', async ({ page, taskflow }) => {
    const response = await page.request.get(`${taskflow.origin}/api/health`)
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  /**
   * `parallelIndex`, so the port survives a worker restart. `workerIndex` counts
   * upwards forever, and the second worker to be restarted would ask for a port
   * nothing is listening on.
   */
  test('talks to the database the fixture named', async ({ page, db, taskflow }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-item')).toHaveCount(SEED.length)

    expect(taskflow.database).toContain(`worker-${String(taskflow.worker)}`)
    expect(stored(db)).toHaveLength(SEED.length)
  })
})

/**
 * The way out, which exists for exactly one reason.
 *
 * #54 needs a spec that fails because a *different* spec left state behind, and
 * a harness that makes that impossible would make the failure impossible to
 * demonstrate. Opting out is one visible line at the top of a file; the point of
 * the default is that leakage cannot happen without somebody writing it down.
 */
test.describe('opting out of the reset', () => {
  test.use({ resetDatabase: false })

  test('leaves a task behind on purpose', async ({ page, db }) => {
    await page.goto('/')
    await add(page, 'deliberately left behind')

    expect(stored(db).map((task) => task.title)).toContain('deliberately left behind')
  })

  test('finds it still there, because this block asked not to be reset', async ({ page, db }) => {
    await page.goto('/')

    expect(stored(db).map((task) => task.title)).toContain('deliberately left behind')
    await expect(page.getByText('deliberately left behind')).toBeVisible()
  })
})

test.describe('every test starts from the seed', () => {
  test('adds a task, which the next test must not see', async ({ page, db }) => {
    await page.goto('/')
    await add(page, 'left behind by the previous test')

    await expect(page.getByTestId('task-item')).toHaveCount(SEED.length + 1)
    expect(stored(db)).toHaveLength(SEED.length + 1)
  })

  test('sees the seed, and only the seed', async ({ page, db }) => {
    await page.goto('/')

    await expect(page.getByTestId('task-item')).toHaveCount(SEED.length)
    expect(stored(db).map((task) => task.title)).toEqual(SEED.map((task) => task.title))
    // The id sequence too: reseeding replaces the rows and resets the counter,
    // so a fixture that can name a row by id keeps being able to.
    expect(stored(db)[0]?.id).toBe(1)
  })
})
