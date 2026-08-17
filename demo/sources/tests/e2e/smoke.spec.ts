test('the application responds on the configured port', async ({ request }) => {
  const response = await request.get('/health')
  expect(response.status()).toBe(200)
})
