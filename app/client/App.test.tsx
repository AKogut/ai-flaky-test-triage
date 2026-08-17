// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  // The filter lives in the query string, so a test that set one would otherwise
  // deep-link the next test into a filtered view.
  window.history.replaceState(null, '', '/')
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

// ---------------------------------------------------------------------------
// The task lifecycle
// ---------------------------------------------------------------------------

/**
 * These flows are the control group for the non-flaky specs in #51, so they are
 * tested for *stability* as much as for behaviour: no refetch that races another
 * write, no double submit, and a rollback that puts back one field rather than a
 * remembered list.
 */
describe('creating', () => {
  const listThen = (created: Task): void => {
    fetchMock.mockResolvedValueOnce(respond([]))
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: created }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  it('adds the task the server returned', async () => {
    listThen(task({ id: 9, title: 'a new thing' }))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())
    await userEvent.type(screen.getByLabelText('New task'), 'a new thing')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    await waitFor(() => expect(screen.getByText('a new thing')).toBeDefined())
  })

  /**
   * A refetch after a write races every other write in flight. There is exactly
   * one deliberate race in this application and it is not here.
   */
  it('does not refetch the list afterwards', async () => {
    listThen(task({ id: 9, title: 'a new thing' }))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())
    await userEvent.type(screen.getByLabelText('New task'), 'a new thing')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(screen.getByText('a new thing')).toBeDefined())

    // One GET and one POST. A third call would be the refetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clears the field, so a second task does not inherit the first title', async () => {
    listThen(task({ id: 9, title: 'a new thing' }))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())
    await userEvent.type(screen.getByLabelText('New task'), 'a new thing')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    await waitFor(() => expect(screen.getByLabelText('New task')).toHaveProperty('value', ''))
  })

  /** A form that submits twice is a data bug that presents as a test counting rows. */
  it('refuses an empty title rather than posting one', async () => {
    fetchMock.mockResolvedValue(respond([]))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Add task' })).toHaveProperty('disabled', true)
  })

  /**
   * The disabled button is not the whole guard: Enter in the field submits the
   * form directly. A double submit is a data bug that presents as a test
   * counting rows, which is exactly the contamination #51's control group cannot
   * have.
   */
  it('creates one task when the button is clicked twice before the first lands', async () => {
    fetchMock.mockResolvedValueOnce(respond([]))
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())

    let settle: (response: Response) => void = () => undefined
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      }),
    )

    await userEvent.type(screen.getByLabelText('New task'), 'once')
    const button = screen.getByRole('button', { name: 'Add task' })
    await userEvent.click(button)
    await userEvent.click(button)

    settle(
      new Response(JSON.stringify({ task: task({ id: 9, title: 'once' }) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.getByText('once')).toBeDefined())

    // One GET and one POST. Two POSTs would be two tasks named "once".
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  /**
   * The disabled button does not stop this one: a form still submits on Enter
   * while its submit button is disabled, so the early return in the handler is
   * the guard that matters here.
   */
  it('ignores Enter while a create is already in flight', async () => {
    fetchMock.mockResolvedValueOnce(respond([]))
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())

    let settle: (response: Response) => void = () => undefined
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      }),
    )

    const field = screen.getByLabelText('New task')
    await userEvent.type(field, 'once{Enter}')
    await userEvent.type(field, '{Enter}')

    settle(
      new Response(JSON.stringify({ task: task({ id: 9, title: 'once' }) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.getByText('once')).toBeDefined())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces a failure in the UI rather than the console', async () => {
    fetchMock.mockResolvedValueOnce(respond([]))
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'invalid_request', message: 'title is required' } }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined())
    await userEvent.type(screen.getByLabelText('New task'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    await waitFor(() => expect(screen.getByTestId('write-error')).toBeDefined())
    expect(screen.getByTestId('write-error').textContent).toContain('title is required')
  })

  it('lets the error be dismissed without reloading', async () => {
    fetchMock.mockResolvedValueOnce(respond([task()]))
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
    await userEvent.type(screen.getByLabelText('New task'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    await waitFor(() => expect(screen.getByTestId('write-error')).toBeDefined())
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByTestId('write-error')).toBeNull()
    // The list is still there: a failed write never blocks reading.
    expect(screen.getByTestId('task-list')).toBeDefined()
  })
})

describe('editing', () => {
  const openEditor = async (): Promise<void> => {
    fetchMock.mockResolvedValueOnce(respond([task({ id: 3, title: 'before' })]))
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
  }

  it('saves the new title', async () => {
    await openEditor()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: task({ id: 3, title: 'after' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await userEvent.clear(screen.getByLabelText('Title'))
    await userEvent.type(screen.getByLabelText('Title'), 'after')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText('after')).toBeDefined())
    expect(screen.queryByTestId('edit-form')).toBeNull()
  })

  it('leaves the task alone when cancelled', async () => {
    await openEditor()
    await userEvent.clear(screen.getByLabelText('Title'))
    await userEvent.type(screen.getByLabelText('Title'), 'discarded')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('before')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('will not save an empty title', async () => {
    await openEditor()
    await userEvent.clear(screen.getByLabelText('Title'))
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })

  /** The disabled button is not the whole guard — Enter submits the form directly. */
  it('will not save an empty title on Enter either', async () => {
    await openEditor()
    await userEvent.clear(screen.getByLabelText('Title'))
    await userEvent.type(screen.getByLabelText('Title'), '{Enter}')

    expect(screen.getByTestId('edit-form')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('deleting', () => {
  const setup = async (): Promise<void> => {
    fetchMock.mockResolvedValueOnce(respond([task({ id: 4, title: 'doomed' })]))
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
  }

  /**
   * Two steps in the page rather than `window.confirm`. A native dialog blocks
   * the event loop and has to be intercepted by name in Playwright, which is a
   * genuine source of intermittent failures.
   */
  it('asks before deleting', async () => {
    await setup()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(screen.getByTestId('delete-confirm')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('removes the row once confirmed', async () => {
    await setup()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

    await waitFor(() => expect(screen.queryByText('doomed')).toBeNull())
  })

  it('keeps the task when the confirmation is cancelled', async () => {
    await setup()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('doomed')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('completing', () => {
  const setup = async (over: Partial<Task> = {}): Promise<void> => {
    fetchMock.mockResolvedValueOnce(respond([task({ id: 5, ...over })]))
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('task-list')).toBeDefined())
  }

  /**
   * The optimistic path, and the seed of the race in #46. It has to paint before
   * the request settles or there is nothing for that race to be about.
   */
  it('paints the change before the server answers', async () => {
    await setup()
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))

    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))
    expect(screen.getByTestId('task-status').textContent).toBe('Done')
  })

  it('keeps the change when the server agrees', async () => {
    await setup()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: task({ id: 5, status: 'completed' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeDefined())
  })

  it('rolls back and says why when the server refuses', async () => {
    await setup()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    await waitFor(() => expect(screen.getByTestId('write-error')).toBeDefined())
    expect(screen.getByTestId('task-status').textContent).toBe('To do')
  })

  /**
   * The rollback names the field rather than restoring a remembered list. A
   * snapshot restored after the request would silently undo whatever landed in
   * between — a data-loss bug wearing the costume of a rollback.
   */
  it('rolls back without undoing a task created while it was in flight', async () => {
    await setup()

    let refuse: (failure: Error) => void = () => undefined
    fetchMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = reject
      }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: task({ id: 6, title: 'landed meanwhile' }) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await userEvent.type(screen.getByLabelText('New task'), 'landed meanwhile')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(screen.getByText('landed meanwhile')).toBeDefined())

    refuse(new TypeError('Failed to fetch'))

    await waitFor(() => expect(screen.getByTestId('write-error')).toBeDefined())
    expect(screen.getByText('landed meanwhile')).toBeDefined()
    expect(screen.getAllByTestId('task-status')[0]?.textContent).toBe('To do')
  })

  it('reopens a completed task through the ordinary patch route', async () => {
    await setup({ status: 'completed' })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: task({ id: 5, status: 'active' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete' })).toBeDefined())
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/tasks/5')
  })

  it('completes through the dedicated route, which #47 delays', async () => {
    await setup()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: task({ id: 5, status: 'completed' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/tasks/5/complete'))
  })
})

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('filtering', () => {
  const mixed = (): Task[] => [
    task({ id: 1, title: 'still going' }),
    task({ id: 2, title: 'finished', status: 'completed' }),
    task({ id: 3, title: 'also finished', status: 'completed' }),
  ]

  const titles = (): (string | null)[] =>
    screen
      .queryAllByTestId('task-item')
      .map((row) => row.querySelector('.task-title')?.textContent ?? null)

  it('shows everything by default', async () => {
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('narrows to active', async () => {
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    await userEvent.click(screen.getByRole('button', { name: 'Active' }))

    expect(titles()).toEqual(['still going'])
  })

  it('narrows to completed', async () => {
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    await userEvent.click(screen.getByRole('button', { name: 'Completed' }))

    expect(titles()).toEqual(['finished', 'also finished'])
  })

  it('puts the filter in the query string', async () => {
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    await userEvent.click(screen.getByRole('button', { name: 'Completed' }))
    expect(window.location.search).toBe('?filter=completed')

    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(window.location.search).toBe('')
  })

  /** A shared link has to show what the sharer was looking at. */
  it('deep-links into a filtered view on load', async () => {
    window.history.replaceState(null, '', '/?filter=completed')
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Completed' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('does not request anything when the filter changes', async () => {
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    const before = fetchMock.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Active' }))
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('survives a mutation', async () => {
    fetchMock.mockResolvedValueOnce(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    await userEvent.click(screen.getByRole('button', { name: 'Active' }))

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: task({ id: 4, title: 'brand new' }) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await userEvent.type(screen.getByLabelText('New task'), 'brand new')
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    await waitFor(() => expect(titles()).toEqual(['still going', 'brand new']))
    expect(window.location.search).toBe('?filter=active')
  })

  it('says which kind of empty it is', async () => {
    fetchMock.mockResolvedValue(respond([task({ id: 2, status: 'completed' })]))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: 'Active' }))

    expect(screen.getByTestId('empty-state').textContent).toContain('Everything here is done')
  })

  /**
   * The point of the feature, and the reason it was chosen. Every row renders the
   * same status label, so how many elements a text locator matches depends on the
   * filter — and a Playwright locator resolving to more than one element fails in
   * strict mode. A spec written under one filter breaks under another for reasons
   * that have nothing to do with timing, which is exactly the flakiness a
   * timing-focused classifier misreads.
   */
  it('shows text that is unique under one filter and ambiguous under another', async () => {
    fetchMock.mockResolvedValue(respond(mixed()))
    render(<App />)

    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
    expect(screen.getAllByText('To do')).toHaveLength(1)
    expect(screen.getAllByText('Done')).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'Active' }))
    expect(screen.getAllByText('To do')).toHaveLength(1)
    expect(screen.queryAllByText('Done')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Reordering
// ---------------------------------------------------------------------------

describe('reordering', () => {
  const three = (): Task[] => [
    task({ id: 1, title: 'first', position: 1 }),
    task({ id: 2, title: 'second', position: 2 }),
    task({ id: 3, title: 'third', position: 3 }),
  ]

  const titles = (): (string | undefined)[] =>
    screen
      .getAllByTestId('task-item')
      .map((row) => row.querySelector('.task-title')?.textContent ?? undefined)

  const rowFor = (title: string): HTMLElement => {
    const row = screen
      .getAllByTestId('task-item')
      .find((element) => element.textContent?.includes(title))
    if (row === undefined) throw new Error(`no row showing "${title}"`)
    return row
  }

  const listed = (tasks: Task[]): Response =>
    new Response(JSON.stringify({ tasks }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  const ready = async (): Promise<void> => {
    fetchMock.mockResolvedValueOnce(respond(three()))
    render(<App />)
    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))
  }

  describe('by keyboard', () => {
    it('moves a task up one place', async () => {
      await ready()
      fetchMock.mockResolvedValueOnce(
        listed([
          task({ id: 1, title: 'first' }),
          task({ id: 3, title: 'third' }),
          task({ id: 2, title: 'second' }),
        ]),
      )

      await userEvent.click(within(rowFor('third')).getByRole('button', { name: 'Move up' }))
      await waitFor(() => expect(titles()).toEqual(['first', 'third', 'second']))
    })

    it('moves a task down one place', async () => {
      await ready()
      fetchMock.mockResolvedValueOnce(
        listed([
          task({ id: 2, title: 'second' }),
          task({ id: 1, title: 'first' }),
          task({ id: 3, title: 'third' }),
        ]),
      )

      await userEvent.click(within(rowFor('first')).getByRole('button', { name: 'Move down' }))
      await waitFor(() => expect(titles()).toEqual(['second', 'first', 'third']))
    })

    /** A control reachable only by drag is unusable without a pointer. */
    it('offers no move at the ends of the list', async () => {
      await ready()
      expect(within(rowFor('first')).getByRole('button', { name: 'Move up' })).toHaveProperty(
        'disabled',
        true,
      )
      expect(within(rowFor('third')).getByRole('button', { name: 'Move down' })).toHaveProperty(
        'disabled',
        true,
      )
    })
  })

  describe('by drag', () => {
    it('reorders on drop', async () => {
      await ready()
      fetchMock.mockResolvedValueOnce(
        listed([
          task({ id: 3, title: 'third' }),
          task({ id: 1, title: 'first' }),
          task({ id: 2, title: 'second' }),
        ]),
      )

      fireEvent.dragStart(rowFor('third'))
      fireEvent.dragOver(rowFor('first'))
      fireEvent.drop(rowFor('first'))

      await waitFor(() => expect(titles()).toEqual(['third', 'first', 'second']))
    })

    it('ignores a drop on the row being dragged', async () => {
      await ready()
      fireEvent.dragStart(rowFor('first'))
      fireEvent.drop(rowFor('first'))

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('ignores a drop with nothing being dragged', async () => {
      await ready()
      fireEvent.drop(rowFor('second'))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  /** The optimistic half. Without it a drag would wait on a round trip to show anything. */
  it('paints the new order before the server answers', async () => {
    await ready()
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))

    await userEvent.click(within(rowFor('third')).getByRole('button', { name: 'Move up' }))
    expect(titles()).toEqual(['first', 'third', 'second'])
  })

  /** Dropping onto a row above lands before it; the server is asked for the same thing. */
  it('asks the server for the index it painted', async () => {
    await ready()
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))

    fireEvent.dragStart(rowFor('third'))
    fireEvent.drop(rowFor('first'))

    expect(titles()).toEqual(['third', 'first', 'second'])
    const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    const body = call[1].body
    expect(call[0]).toBe('/api/tasks/reorder')
    expect(typeof body === 'string' ? JSON.parse(body) : null).toEqual({ id: 3, index: 0 })
  })

  it('re-reads the list when the reorder fails', async () => {
    await ready()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    fetchMock.mockResolvedValueOnce(respond(three()))

    await userEvent.click(within(rowFor('third')).getByRole('button', { name: 'Move up' }))

    await waitFor(() => expect(screen.getByTestId('write-error')).toBeDefined())
    await waitFor(() => expect(titles()).toEqual(['first', 'second', 'third']))
  })
})

/**
 * The bug this application exists to have, asserted rather than hidden.
 *
 * It is `app_code` + `intermittent` — the hard quadrant — and the whole project
 * is built to classify it from a trace. A test that pins it is the only thing
 * standing between "a deliberate fixture" and "somebody tidied it away on a
 * Friday", so this one fails if the race is fixed, and says so.
 *
 * See the comment on `move` in useTasks.ts for the interleaving.
 */
describe('the deliberate reconciliation race', () => {
  const order = (...titles: string[]): Response =>
    new Response(
      JSON.stringify({
        tasks: titles.map((title, index) => task({ id: index + 10, title, position: index + 1 })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  it('applies whichever response arrives last, not whichever was sent last', async () => {
    fetchMock.mockResolvedValueOnce(
      respond([
        task({ id: 1, title: 'first', position: 1 }),
        task({ id: 2, title: 'second', position: 2 }),
        task({ id: 3, title: 'third', position: 3 }),
      ]),
    )
    render(<App />)
    await waitFor(() => expect(screen.getAllByTestId('task-item')).toHaveLength(3))

    const titles = (): (string | undefined)[] =>
      screen
        .getAllByTestId('task-item')
        .map((element) => element.querySelector('.task-title')?.textContent ?? undefined)
    const move = async (title: string, direction: 'Move up' | 'Move down'): Promise<void> => {
      const row = screen
        .getAllByTestId('task-item')
        .find((element) => element.textContent?.includes(title))
      if (row === undefined) throw new Error(`no row showing "${title}"`)
      await userEvent.click(within(row).getByRole('button', { name: direction }))
    }

    // R1 goes out and is held open.
    let answerFirst: (response: Response) => void = () => undefined
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve
      }),
    )
    await move('third', 'Move up')

    // R2 goes out second and answers first, with the server's order after both.
    fetchMock.mockResolvedValueOnce(order('after', 'both', 'moves'))
    await move('second', 'Move up')
    await waitFor(() => expect(titles()).toEqual(['after', 'both', 'moves']))

    // R1 answers late, carrying the server's order after only the first move.
    answerFirst(order('after', 'the', 'first'))

    // The newer request's result is overwritten by the older one's response.
    // The user's second drag is visibly undone; the server still has it, which
    // is what makes this so hard to catch by hand.
    await waitFor(() => expect(titles()).toEqual(['after', 'the', 'first']))
  })
})
