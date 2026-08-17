import { describe, expect, it } from 'vitest'
import type { Task } from './api.js'
import { FILTERS, filterQuery, parseFilter, visible } from './useFilter.js'

/**
 * The pure half of filtering, tested without a DOM.
 *
 * The hook itself is exercised through the component, where the query string and
 * the rendered list can be checked together. These are the parts a deep link
 * depends on, and a deep link that silently falls back is a shared URL that
 * shows the wrong thing to whoever opened it.
 */

const task = (id: number, status: Task['status']): Task => ({
  id,
  title: `task ${String(id)}`,
  description: '',
  status,
  position: id,
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-01-15T09:00:00.000Z',
})

const tasks = [task(1, 'active'), task(2, 'completed'), task(3, 'active')]

describe('reading the filter from a URL', () => {
  it.each(FILTERS)('recognises %s', (filter) => {
    expect(parseFilter(`?filter=${filter}`)).toBe(filter)
  })

  it('defaults to all when there is no parameter', () => {
    expect(parseFilter('')).toBe('all')
  })

  /** A typo in a shared link should still show tasks, not an error page. */
  it.each(['?filter=done', '?filter=', '?other=active', '?filter=ACTIVE'])(
    'falls back to all for %s',
    (search) => {
      expect(parseFilter(search)).toBe('all')
    },
  )

  it('ignores the rest of the query string', () => {
    expect(parseFilter('?utm=x&filter=completed&y=1')).toBe('completed')
  })
})

describe('writing the filter to a URL', () => {
  it('omits the parameter for the default, because the default belongs in the code', () => {
    expect(filterQuery('all')).toBe('')
  })

  it.each(['active', 'completed'] as const)('writes %s', (filter) => {
    expect(filterQuery(filter)).toBe(`?filter=${filter}`)
  })

  it('round-trips every filter', () => {
    for (const filter of FILTERS) expect(parseFilter(filterQuery(filter))).toBe(filter)
  })
})

describe('applying the filter', () => {
  it('shows everything under all', () => {
    expect(visible(tasks, 'all')).toHaveLength(3)
  })

  it('shows only what is left to do under active', () => {
    expect(visible(tasks, 'active').map((t) => t.id)).toEqual([1, 3])
  })

  it('shows only what is finished under completed', () => {
    expect(visible(tasks, 'completed').map((t) => t.id)).toEqual([2])
  })

  it('keeps the order it was given rather than sorting again', () => {
    const reversed = [...tasks].reverse()
    expect(visible(reversed, 'all').map((t) => t.id)).toEqual([3, 2, 1])
  })

  it('does not mutate the list it was handed', () => {
    const original = [...tasks]
    visible(tasks, 'active')
    expect(tasks).toEqual(original)
  })
})
