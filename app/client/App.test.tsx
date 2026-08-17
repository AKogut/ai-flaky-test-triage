// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import type { Task } from './api.js'

/**
 * The client, rendered.
 *
 * `fetch` is stubbed rather than a server started: these are about what the
 * component does with an answer, and the answers worth testing — a 500, an
 * unreachable host — are ones a real server would not give on demand. The API
 * itself is covered against a real port in `app/server`.
 *
 * There is a second job here. This application exists to *contain* flakiness
 * honestly, so its own unit tests must not be flaky: every assertion below is on
 * a settled state, and none of them waits on a timer.
 */

const task = (over: Partial<Task> = {}): Task => ({
  id: 1,
  title: 'Write the incident postmortem',
  description: 'Due Friday.',
  status: 'active',
  position: 1,
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-01-15T09:00:00.000Z',
  ...over,
})

const respond = (tasks: Task[]): Response =>
  new Response(JSON.stringify({ tasks }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('loading', () => {
  it('says so while the request is in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined))
    render(<App />)
    expect(screen.getByTestId('loading-state')).toBeDefined()
  })

  /**
   * `role="status"` rather than a bare paragraph: a screen reader announces the
   * change, and a Playwright spec can wait on the role instead of a class name.
   */
  it('announces itself to assistive technology', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined))
    render(<App />)
    expect(screen.getByRole('status').textContent).toContain('Loading')
  })
})

describe('the list', () => {
  it('renders one row per task', async () => {
    fetchMock.mockResolvedValue(respond([task(), task({ id: 2, title: 'Review the plan' })]))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(2))
    expect(screen.getByText('Review the plan')).toBeDefined()
  })

  it('keeps the order the server sent, rather than sorting again', async () => {
    fetchMock.mockResolvedValue(
      respond([task({ id: 3, title: 'third' }), task({ id: 1, title: 'first' })]),
    )
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(2))
    const titles = screen.getAllByTestId('task-item').map((row) => row.textContent)
    expect(titles[0]).toContain('third')
    expect(titles[1]).toContain('first')
  })

  it('shows a completed task as done', async () => {
    fetchMock.mockResolvedValue(respond([task({ status: 'completed' })]))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('task-status').textContent).toBe('Done'))
  })

  it('omits the description when there is none', async () => {
    fetchMock.mockResolvedValue(respond([task({ description: '' })]))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('task-item')).toBeDefined())
    expect(screen.getByTestId('task-item').querySelector('.task-description')).toBeNull()
  })

  it('carries the task id, so a spec can address a row without counting', async () => {
    fetchMock.mockResolvedValue(respond([task({ id: 42 })]))
    render(<App />)

    await waitFor(() =>
      expect(screen.getByTestId('task-item').getAttribute('data-task-id')).toBe('42'),
    )
  })
})

describe('the empty state', () => {
  it('is a state, not an empty list', async () => {
    fetchMock.mockResolvedValue(respond([]))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())
    expect(screen.queryByTestId('task-list')).toBeNull()
  })
})

describe('the error state', () => {
  it('shows what the server said, not a generic apology', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'internal', message: 'the database is down' } }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('error-state')).toBeDefined())
    expect(screen.getByRole('alert').textContent).toContain('the database is down')
  })

  it('says the server is unreachable when fetch itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<App />)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be reached'),
    )
  })

  it('recovers when the retry succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    fetchMock.mockResolvedValue(respond([task()]))
    render(<App />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
    expect(screen.queryByTestId('error-state')).toBeNull()
  })
})

describe('refreshing', () => {
  it('asks the server again', async () => {
    fetchMock.mockResolvedValue(respond([task()]))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
    const before = fetchMock.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before))
  })
})

/**
 * The selector policy, asserted rather than only described.
 *
 * The golden dataset contains failures that exist only because it is made this
 * way, so a well-meant "let's add ids to the buttons" would delete a fixture's
 * premise while every test stayed green.
 */
describe('the selector policy', () => {
  it('gives structural containers a test id', async () => {
    fetchMock.mockResolvedValue(respond([task()]))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
    expect(screen.getByTestId('task-item')).toBeDefined()
    expect(screen.getByTestId('task-status')).toBeDefined()
  })

  it('leaves interactive controls to be found by their accessible name', async () => {
    fetchMock.mockResolvedValue(respond([task()]))
    const { container } = render(<App />)

    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
    for (const button of container.querySelectorAll('button')) {
      expect(button.getAttribute('data-testid')).toBeNull()
    }
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined()
  })
})

/**
 * A console warning is a real defect in a React application — a key collision, a
 * state update after unmount — and every one of them is a plausible cause of an
 * intermittent test. In an application built to make flakiness explicable, they
 * cannot be background noise.
 */
describe('a clean run', () => {
  it('logs no errors or warnings', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    fetchMock.mockResolvedValue(respond([task(), task({ id: 2 })]))
    render(<App />)
    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(2))

    expect(errors.mock.calls).toEqual([])
    expect(warnings.mock.calls).toEqual([])
  })
})
