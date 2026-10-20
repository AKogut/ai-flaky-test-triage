import { expect, test } from '@playwright/test'

// Source for tests/fixtures/reporters/playwright-<version>.json: one test per
// shape the normaliser has to read. No browser is launched.

test.describe('task board', () => {
  test('lists tasks after load', async () => {
    expect(['a', 'b']).toHaveLength(2)
  })

  test.describe('reorder', () => {
    test('moves a task above its neighbour', async () => {
      expect(['b', 'a']).toEqual(['a', 'b'])
    })
  })
})

test('completion toggle settles before assertion', async ({}, testInfo) => {
  // Fails on the first attempt and passes on the retry.
  const n = testInfo.retry
  expect(n).toBeGreaterThan(0)
})

test('drag handle is present', async () => {
  test.skip(true, 'covered by keyboard reorder')
})

test('slow operation finishes in time', async () => {
  test.setTimeout(150)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
})
