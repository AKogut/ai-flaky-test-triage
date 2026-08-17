test('hides completed tasks when the toggle is off', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('filter-completed').click()
  await expect(page.getByRole('listitem')).toHaveCount(2)
})
