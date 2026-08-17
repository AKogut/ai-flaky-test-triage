import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  completeTask,
  createTask,
  deleteTask,
  listTasks,
  reorderTask,
  updateTask,
  type Task,
} from './api.js'

/**
 * The API client, against a stubbed `fetch`.
 *
 * Every function here is tested even though the UI only calls one of them yet.
 * The rest arrive with #44 to #46, and code that exists without a test is code
 * whose first exercise is a feature branch that has other things to prove.
 *
 * The error paths are the reason this file is longer than the module. A network
 * failure, a 404, a 500 with a structured body and a 500 without one are four
 * different things a caller may want to distinguish, and flattening them is how
 * a UI ends up apologising generically for a problem it could have named.
 */

const task: Task = {
  id: 1,
  title: 'a task',
  description: '',
  status: 'active',
  position: 1,
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-01-15T09:00:00.000Z',
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const lastCall = (): [string, RequestInit] =>
  fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]

/**
 * What was sent, parsed — and an assertion in its own right.
 *
 * `RequestInit['body']` admits a Blob or a stream, so reading it as text would
 * be a guess. Refusing anything but a string pins a property worth pinning: this
 * client sends JSON, and a future one that started streaming would fail here
 * rather than in a server log.
 */
const sent = (init: RequestInit): unknown => {
  const { body } = init
  if (typeof body !== 'string') throw new Error('the client sent a body that is not a JSON string')
  return JSON.parse(body)
}

describe('reading', () => {
  it('unwraps the list', async () => {
    fetchMock.mockResolvedValue(json({ tasks: [task] }))
    expect(await listTasks()).toEqual([task])
    expect(lastCall()[0]).toBe('/api/tasks')
  })

  /** Relative, so the dev proxy serves it same-origin and there is no CORS to debug. */
  it('asks a relative path when no base is configured', async () => {
    fetchMock.mockResolvedValue(json({ tasks: [] }))
    await listTasks()
    expect(lastCall()[0].startsWith('/')).toBe(true)
  })
})

describe('writing', () => {
  it('creates', async () => {
    fetchMock.mockResolvedValue(json({ task }, 201))
    expect(await createTask('a task', 'with detail')).toEqual(task)

    const [path, init] = lastCall()
    expect([path, init.method]).toEqual(['/api/tasks', 'POST'])
    expect(sent(init)).toEqual({ title: 'a task', description: 'with detail' })
  })

  it('defaults the description rather than omitting the field', async () => {
    fetchMock.mockResolvedValue(json({ task }, 201))
    await createTask('a task')
    expect(sent(lastCall()[1])).toEqual({ title: 'a task', description: '' })
  })

  it('patches only what it was given', async () => {
    fetchMock.mockResolvedValue(json({ task }))
    await updateTask(7, { title: 'renamed' })

    const [path, init] = lastCall()
    expect([path, init.method]).toEqual(['/api/tasks/7', 'PATCH'])
    expect(sent(init)).toEqual({ title: 'renamed' })
  })

  it('completes through the dedicated route', async () => {
    fetchMock.mockResolvedValue(json({ task: { ...task, status: 'completed' } }))
    expect((await completeTask(7)).status).toBe('completed')
    expect(lastCall()[0]).toBe('/api/tasks/7/complete')
  })

  it('reorders and returns the resulting order', async () => {
    fetchMock.mockResolvedValue(json({ tasks: [task] }))
    expect(await reorderTask(7, 2)).toEqual([task])

    const [path, init] = lastCall()
    expect(path).toBe('/api/tasks/reorder')
    expect(sent(init)).toEqual({ id: 7, index: 2 })
  })

  /** 204 has no body, and calling `.json()` on it throws — a delete that reports failure. */
  it('handles a 204 with no body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteTask(7)).resolves.toBeUndefined()
  })
})

describe('failing', () => {
  it('carries the server code and message through', async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: 'invalid_request', message: 'title is required' } }, 400),
    )
    await expect(createTask('')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'title is required',
    })
  })

  it('is an ApiError, so a caller can tell it from a programming mistake', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'not_found', message: 'gone' } }, 404))
    await expect(updateTask(99, {})).rejects.toBeInstanceOf(ApiError)
  })

  it('falls back when the body is not the shape the server promises', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway timeout</html>', { status: 504 }))
    await expect(listTasks()).rejects.toMatchObject({ status: 504, code: 'unknown' })
  })

  /**
   * Status 0 cannot collide with a real one, so a caller checking `status === 500`
   * is never accidentally right about a request that never arrived.
   */
  it('reports an unreachable server as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(listTasks()).rejects.toMatchObject({ status: 0, code: 'unreachable' })
  })

  /**
   * A client that quietly retries a failed write turns a race into an occasional
   * double-write — a harder failure to reason about and a less honest one to
   * hand a triage agent.
   */
  it('does not retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(createTask('a task')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
