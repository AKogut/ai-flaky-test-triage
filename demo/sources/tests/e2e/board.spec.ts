test('completing a task while its title is saved keeps both changes', async ({ page }) => {
  await page.goto('/')
  const row = page.getByRole('listitem').filter({ hasText: 'Ship it' })
  const status = row.getByTestId('status')

  await Promise.all([page.getByRole('checkbox').click(), saveTitle('Ship it')])
  await expect(status).toHaveText('Done')
})
