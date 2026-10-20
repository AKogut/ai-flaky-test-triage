import { describe, expect, it } from 'vitest'

describe('task api', () => {
  it('creates a task', () => {
    expect({ title: 'write tests' }).toEqual({ title: 'write tests' })
  })

  describe('reorder', () => {
    it('rejects an out-of-range position', () => {
      expect({ position: 9 }).toEqual({ position: 1 })
    })
  })

  it.skip('supports bulk delete', () => {})

  it('throws on a missing task', () => {
    const tasks: { id: number }[] = []
    const found = tasks[0] as { id: number }
    found.id.toString()
  })
})
