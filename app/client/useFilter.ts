import { useCallback, useState } from 'react'
import type { Task } from './api.js'

/**
 * Which tasks the list shows, and the query string that says so.
 *
 * No router. One query parameter, read once on mount and written on every
 * change, is the whole feature — and a routing library would be another
 * dependency to rule out when a test goes flaky, which is the standing argument
 * against every dependency in this application.
 *
 * `replaceState` rather than `pushState`. A history entry per filter click needs
 * a `popstate` listener to be worth anything, and without one the back button
 * appears to do nothing — a worse bug than having no history entry, and a
 * genuinely confusing one to hit in a Playwright spec that calls `goBack()`.
 */

export const FILTERS = ['all', 'active', 'completed'] as const
export type Filter = (typeof FILTERS)[number]

export const PARAM = 'filter'

/** Anything unrecognised is `all`, because a typo in a shared link should still show tasks. */
export function parseFilter(search: string): Filter {
  const value = new URLSearchParams(search).get(PARAM)
  return FILTERS.find((filter) => filter === value) ?? 'all'
}

/** `?filter=active`, and no parameter at all for `all` — the default belongs in the code. */
export function filterQuery(filter: Filter): string {
  return filter === 'all' ? '' : `?${PARAM}=${filter}`
}

export function useFilter(): { filter: Filter; setFilter: (next: Filter) => void } {
  const [filter, setLocal] = useState<Filter>(() => parseFilter(window.location.search))

  const setFilter = useCallback((next: Filter) => {
    setLocal(next)
    window.history.replaceState(null, '', `${window.location.pathname}${filterQuery(next)}`)
  }, [])

  return { filter, setFilter }
}

/**
 * The filter itself: three states over one field.
 *
 * Applied in the client rather than as a server query parameter. It is one line
 * either way, and doing it here means switching filters never issues a request —
 * so a spec that changes the filter is not also waiting on a network round trip
 * it did not ask for.
 */
export const visible = (tasks: readonly Task[], filter: Filter): Task[] =>
  filter === 'all' ? [...tasks] : tasks.filter((task) => task.status === status(filter))

const status = (filter: Exclude<Filter, 'all'>): Task['status'] =>
  filter === 'completed' ? 'completed' : 'active'
