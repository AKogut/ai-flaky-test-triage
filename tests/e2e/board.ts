import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.js'

/**
 * The handful of things every spec does, named once.
 *
 * Deliberately thin. A full page object would hide the locators, and the specs
 * in this directory are meant to be read side by side with the flaky ones in
 * #52–#55 — a reader has to be able to see *which* selector a test chose and
 * judge it. So this exposes locators and performs actions; it never asserts on
 * behalf of a spec, except where the assertion is the wait.
 *
 * ## The locator policy these helpers follow
 *
 * Containers by test id, controls by role and name, text by text. That is the
 * policy `app/client/App.tsx` documents from the other side, and it is what
 * makes a renamed button a legitimate test failure rather than an invisible one.
 */

/** Structural containers, by the ids the application commits to. */
export const list = (page: Page): Locator => page.getByTestId('task-list')
export const items = (page: Page): Locator => page.getByTestId('task-item')
export const emptyState = (page: Page): Locator => page.getByTestId('empty-state')
export const writeError = (page: Page): Locator => page.getByTestId('write-error')

/** One row, by its exact title. Exact, so `Review the migration plan` cannot match two rows. */
export const row = (page: Page, title: string): Locator =>
  items(page).filter({ has: page.getByText(title, { exact: true }) })

/**
 * One row by the id the application renders on it.
 *
 * For the cases where the title is not a usable handle — while a row is being
 * edited its title is the value of an input, so `row()` above matches nothing.
 * Locating by a rendered id is the right answer there and the wrong one
 * elsewhere: a spec that names ids everywhere is a spec that no longer says what
 * a user would say.
 */
export const rowById = (page: Page, id: number): Locator =>
  page.locator(`[data-task-id="${String(id)}"]`)

/** The titles as rendered, in the order they are rendered. The list's whole contract. */
export const titles = (page: Page): Locator => page.locator('.task-title')

/**
 * Open the board and wait for it to have finished loading.
 *
 * The wait is a web-first assertion rather than a sleep: it retries until the
 * loading state is gone, and it fails with "expected hidden, got visible" rather
 * than with whatever the next line happened to trip over. Every spec starts here,
 * so getting this wrong once would look like flakiness everywhere.
 */
export async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`)
  await expect(page.getByTestId('loading-state')).toBeHidden()
}

/** Type a title and submit. The button is disabled until the field has content. */
export async function add(page: Page, title: string): Promise<void> {
  await page.getByPlaceholder('What needs doing?').fill(title)
  await page.getByRole('button', { name: 'Add task' }).click()
}

/** The buttons a row carries, scoped to that row so a name cannot match another one's. */
export const action = (page: Page, title: string, name: string): Locator =>
  row(page, title).getByRole('button', { name, exact: true })
