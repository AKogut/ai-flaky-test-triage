import type { Locator, Page } from '@playwright/test'
import type { Db } from '@sentra/taskflow-server'
import { items, open, row, rowById } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * Editing a task's title and description.
 *
 * The flow that changes the thing every other spec locates by. That is worth
 * saying out loud: a rename moves the selector, and both
 * `assertion-pins-reworded-empty-state` and `button-lookup-uses-superseded-label`
 * in the golden dataset are that failure. This file uses the old title before
 * the rename and the new one after it, on purpose — a spec that kept using the
 * old name would be asserting on a fixture rather than on the application.
 *
 * **While a row is being edited it has no title to find it by.** The title
 * becomes the value of an input, so a locator built from the text matches
 * nothing, and the failure reads as "the row disappeared". These tests hold the
 * row by the id the application renders on it, which is stable across the rename
 * that is the point of the flow. Everywhere else in the suite, locating by id
 * would be worse: it stops saying what a user would say.
 *
 * The edit form is not optimistic. It sends, waits, and applies the row the
 * server returns — so every assertion here is about the final state and none of
 * them needs to know how long the request took.
 */

const TASK = 'Triage the flaky board spec'

/** The row under test, held by id so that renaming it does not lose it. */
const target = (page: Page, db: Db): Locator =>
  rowById(page, stored(db).find((task) => task.title === TASK)?.id ?? 0)

const form = (page: Page, db: Db): Locator => target(page, db).getByTestId('edit-form')

const startEditing = async (page: Page, db: Db): Promise<Locator> => {
  await target(page, db).getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(form(page, db)).toBeVisible()
  return form(page, db)
}

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('opens with the values the task already has', async ({ page, db }) => {
  const editing = await startEditing(page, db)

  await expect(editing.getByLabel('Title')).toHaveValue(TASK)
  await expect(editing.getByLabel('Description')).toHaveValue('It has failed four times this week.')
})

test('saves a new title', async ({ page, db }) => {
  const editing = await startEditing(page, db)

  await editing.getByLabel('Title').fill('Triage the reorder spec')
  await editing.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByText('Triage the reorder spec')).toBeVisible()
  await expect(page.getByText(TASK)).toHaveCount(0)
  expect(stored(db).map((task) => task.title)).toContain('Triage the reorder spec')
})

test('saves a new description', async ({ page, db }) => {
  const editing = await startEditing(page, db)

  await editing.getByLabel('Description').fill('Five times now.')
  await editing.getByRole('button', { name: 'Save' }).click()

  await expect(row(page, TASK)).toContainText('Five times now.')
  expect(stored(db).find((task) => task.title === TASK)?.description).toBe('Five times now.')
})

test('closes the form once the save has landed', async ({ page, db }) => {
  const editing = await startEditing(page, db)
  await editing.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByTestId('edit-form')).toHaveCount(0)
  await expect(row(page, TASK).getByRole('button', { name: 'Edit' })).toBeVisible()
})

test('leaves the task alone when the edit is cancelled', async ({ page, db }) => {
  const editing = await startEditing(page, db)

  await editing.getByLabel('Title').fill('Discarded')
  await editing.getByRole('button', { name: 'Cancel' }).click()

  await expect(page.getByTestId('edit-form')).toHaveCount(0)
  await expect(page.getByText(TASK)).toBeVisible()
  await expect(page.getByText('Discarded')).toHaveCount(0)
  expect(stored(db).map((task) => task.title)).toContain(TASK)
})

test('will not save an empty title', async ({ page, db }) => {
  const editing = await startEditing(page, db)
  const save = editing.getByRole('button', { name: 'Save' })

  await editing.getByLabel('Title').fill('')
  await expect(save).toBeDisabled()

  // Whitespace is not a title. The form stays open and the row keeps its name.
  await editing.getByLabel('Title').fill('   ')
  await expect(save).toBeDisabled()
  expect(stored(db).map((task) => task.title)).toContain(TASK)
})

test('keeps the edit after a reload', async ({ page, db }) => {
  const editing = await startEditing(page, db)

  await editing.getByLabel('Title').fill('Renamed and reloaded')
  await editing.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Renamed and reloaded')).toBeVisible()

  await open(page)
  await expect(page.getByText('Renamed and reloaded')).toBeVisible()
})

/**
 * Two rows can be open at once — each keeps its own state — so the assertion is
 * that they are independent rather than that only one exists. A form that read
 * another row's values would be a data-loss bug wearing the costume of a
 * rendering glitch.
 */
test('edits one row at a time', async ({ page, db }) => {
  const first = await startEditing(page, db)
  await row(page, 'Draft the release notes')
    .getByRole('button', { name: 'Edit', exact: true })
    .click()

  await expect(page.getByTestId('edit-form')).toHaveCount(2)
  await expect(first.getByLabel('Title')).toHaveValue(TASK)
})

test('does not change how many tasks there are', async ({ page, db }) => {
  const before = stored(db).length

  const editing = await startEditing(page, db)
  await editing.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('edit-form')).toHaveCount(0)

  await expect(items(page)).toHaveCount(before)
  expect(stored(db)).toHaveLength(before)
})
