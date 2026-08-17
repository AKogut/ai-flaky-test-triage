/**
 * Everything that talks to the server, in one module.
 *
 * `fetch` and nothing else — no client library, no cache, no query framework.
 * Every dependency here is a dependency somebody has to understand when a test
 * goes flaky, and the entire premise of this application is that its flakiness
 * is explicable.
 *
 * One deliberate omission: there is no retry. A client that quietly retries a
 * failed write turns a race into an occasional double-write, which is a harder
 * failure to reason about and a less honest one to hand a triage agent.
 */

export interface Task {
  id: number
  title: string
  description: string
  status: 'active' | 'completed'
  position: number
  createdAt: string
  updatedAt: string
}

/**
 * A failed request, carrying what the server said.
 *
 * The server's structured error is the useful part — `invalid_request` with the
 * field name is actionable, "Failed to fetch" is not — so it survives to the UI
 * rather than being flattened into a boolean.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Relative by default, so the dev proxy serves it same-origin and there is no CORS to debug. */
const base = (): string => import.meta.env.VITE_API_URL ?? ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${base()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    })
  } catch {
    // A network failure has no status and no body. Status 0 is deliberate: it
    // cannot collide with a real one, so a caller checking `status === 500` is
    // never accidentally right about a request that never arrived.
    throw new ApiError(0, 'unreachable', 'the server could not be reached')
  }

  if (response.status === 204) return undefined as T

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(
      response.status,
      failure?.code ?? 'unknown',
      failure?.message ?? 'the request failed',
    )
  }
  return body as T
}

export const listTasks = async (): Promise<Task[]> =>
  (await request<{ tasks: Task[] }>('/api/tasks')).tasks

export const createTask = async (title: string, description = ''): Promise<Task> =>
  (
    await request<{ task: Task }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    })
  ).task

export const updateTask = async (id: number, patch: Partial<Task>): Promise<Task> =>
  (
    await request<{ task: Task }>(`/api/tasks/${String(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  ).task

export const completeTask = async (id: number): Promise<Task> =>
  (
    await request<{ task: Task }>(`/api/tasks/${String(id)}/complete`, {
      method: 'PATCH',
      body: JSON.stringify({}),
    })
  ).task

export const deleteTask = (id: number): Promise<void> =>
  request<void>(`/api/tasks/${String(id)}`, { method: 'DELETE' })

export const reorderTask = async (id: number, index: number): Promise<Task[]> =>
  (
    await request<{ tasks: Task[] }>('/api/tasks/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ id, index }),
    })
  ).tasks
