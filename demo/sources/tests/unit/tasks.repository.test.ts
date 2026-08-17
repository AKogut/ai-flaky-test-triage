it('paginates without dropping the boundary row', async () => {
  await seed(30)
  const first = await repository.page({ limit: 10 })
  const second = await repository.page({ limit: 10, after: first.cursor })
  expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(20)
})
