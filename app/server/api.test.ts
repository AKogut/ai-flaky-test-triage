import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { clear, open, type Db } from './db.js'
import { serve } from './index.js'
import { seed, SEED, SEED_TIME } from './seed.js'

/**
 * The API over real HTTP, on a real port.
 *
 * Not because a request object could not be faked, but because everything that
 * consumes this API — the client, the Playwright specs, the flaky ones
 * especially — reaches it that way. A test that calls the handler directly
 * verifies the handler; the interesting failures in an app that exists to be
 * flaky live in the layer above it: status codes, JSON parsing, what a malformed
 * body does.
 *
 * `listen(0)` for the port. Hard-coding one would make this suite fail whenever
 * a dev server was running, which is a flaky test with a very boring cause — in
 * a repository about flaky tests.
 */

const db: Db = open(':memory:')
const server = createApp({ db, now: () => SEED_TIME }).listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${String(port)}`

const api = async (
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

const post = (path: string, body: unknown): ReturnType<typeof api> =>
  api(path, { method: 'POST', body: JSON.stringify(body) })
const patch = (path: string, body: unknown): ReturnType<typeof api> =>
  api(path, { method: 'PATCH', body: JSON.stringify(body) })

interface TaskBody {
  task: { id: number; title: string; description: string; status: string; position: number }
}
interface ListBody {
  tasks: TaskBody['task'][]
}

beforeEach(() => {
  clear(db)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
})

describe('reading', () => {
  it('answers health without touching the database', async () => {
    expect(await api('/api/health')).toEqual({ status: 200, body: { status: 'ok' } })
  })

  it('starts empty', async () => {
    expect(await api('/api/tasks')).toEqual({ status: 200, body: { tasks: [] } })
  })

  it('returns one task by id', async () => {
    const created = (await post('/api/tasks', { title: 'read me' })).body as TaskBody
    const found = await api(`/api/tasks/${String(created.task.id)}`)
    expect((found.body as TaskBody).task.title).toBe('read me')
  })

  it('404s for an id that is not there', async () => {
    expect((await api('/api/tasks/999')).status).toBe(404)
  })

  /** `/api/tasks/abc` reaching the database as `NaN` is how a 404 becomes a 500. */
  it('404s for an id that is not a number', async () => {
    expect((await api('/api/tasks/abc')).status).toBe(404)
    expect((await api('/api/tasks/-1')).status).toBe(404)
  })

  it('404s for a route nobody defined', async () => {
    const response = await api('/api/nope')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('creating', () => {
  it('returns 201 and the created task', async () => {
    const response = await post('/api/tasks', { title: 'write the postmortem' })
    expect(response.status).toBe(201)
    expect((response.body as TaskBody).task).toMatchObject({
      title: 'write the postmortem',
      description: '',
      status: 'active',
      position: 1,
    })
  })

  it('appends to the end of the list', async () => {
    await post('/api/tasks', { title: 'first' })
    await post('/api/tasks', { title: 'second' })
    const positions = ((await api('/api/tasks')).body as ListBody).tasks.map((t) => t.position)
    expect(positions).toEqual([1, 2])
  })

  it('trims a title rather than storing the whitespace', async () => {
    const response = await post('/api/tasks', { title: '  padded  ' })
    expect((response.body as TaskBody).task.title).toBe('padded')
  })

  it.each([
    ['no title', {}],
    ['an empty title', { title: '' }],
    ['a whitespace title', { title: '   ' }],
    ['a title of the wrong type', { title: 42 }],
  ])('rejects %s', async (_case, body) => {
    const response = await post('/api/tasks', body)
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } })
  })

  /**
   * A silently ignored field is how a test asserts on something the server never
   * stored, then fails a week later for reasons nobody can reconstruct.
   */
  it('rejects a field it does not know, rather than ignoring it', async () => {
    const response = await post('/api/tasks', { title: 'ok', colour: 'red' })
    expect(response.status).toBe(400)
    const details = (response.body as { error: { details: { path: string }[] } }).error.details
    expect(details.map((d) => d.path)).toContain('colour')
  })

  it('names the field in a 400, so the caller knows what to change', async () => {
    const response = await post('/api/tasks', { title: '' })
    const details = (response.body as { error: { details: { path: string }[] } }).error.details
    expect(details[0]?.path).toBe('title')
  })

  it('answers a malformed body with 400, not a stack trace', async () => {
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_json' } })
  })
})

describe('updating', () => {
  const create = async (): Promise<number> =>
    ((await post('/api/tasks', { title: 'original' })).body as TaskBody).task.id

  it('changes only what the patch names', async () => {
    const id = await create()
    await patch(`/api/tasks/${String(id)}`, { description: 'now with detail' })
    const task = ((await api(`/api/tasks/${String(id)}`)).body as TaskBody).task
    expect(task).toMatchObject({ title: 'original', description: 'now with detail' })
  })

  it('404s for an id that is not there', async () => {
    expect((await patch('/api/tasks/999', { title: 'ghost' })).status).toBe(404)
  })

  /** `PATCH {}` would touch `updated_at`, answer 200, and tell the caller the write worked. */
  it('rejects an empty patch', async () => {
    const id = await create()
    expect((await patch(`/api/tasks/${String(id)}`, {})).status).toBe(400)
  })

  it('rejects a status it does not have', async () => {
    const id = await create()
    expect((await patch(`/api/tasks/${String(id)}`, { status: 'nearly' })).status).toBe(400)
  })

  it('completes a task through its own route', async () => {
    const id = await create()
    const response = await patch(`/api/tasks/${String(id)}/complete`, {})
    expect(response.status).toBe(200)
    expect((response.body as TaskBody).task.status).toBe('completed')
  })

  it('404s when completing something that is gone', async () => {
    expect((await patch('/api/tasks/999/complete', {})).status).toBe(404)
  })
})

describe('deleting', () => {
  it('returns 204 and removes the row', async () => {
    const id = ((await post('/api/tasks', { title: 'temporary' })).body as TaskBody).task.id
    expect((await api(`/api/tasks/${String(id)}`, { method: 'DELETE' })).status).toBe(204)
    expect((await api(`/api/tasks/${String(id)}`)).status).toBe(404)
  })

  it('404s the second time, because there is nothing left to delete', async () => {
    const id = ((await post('/api/tasks', { title: 'temporary' })).body as TaskBody).task.id
    await api(`/api/tasks/${String(id)}`, { method: 'DELETE' })
    expect((await api(`/api/tasks/${String(id)}`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('ordering', () => {
  it('sorts by position', async () => {
    await post('/api/tasks', { title: 'third', position: 3 })
    await post('/api/tasks', { title: 'first', position: 1 })
    await post('/api/tasks', { title: 'second', position: 2 })

    const titles = ((await api('/api/tasks')).body as ListBody).tasks.map((t) => t.title)
    expect(titles).toEqual(['first', 'second', 'third'])
  })

  it('accepts a fractional position, which is what makes reordering one write', async () => {
    await post('/api/tasks', { title: 'a', position: 1 })
    await post('/api/tasks', { title: 'c', position: 2 })
    await post('/api/tasks', { title: 'b', position: 1.5 })

    const titles = ((await api('/api/tasks')).body as ListBody).tasks.map((t) => t.title)
    expect(titles).toEqual(['a', 'b', 'c'])
  })

  /**
   * `position-collision-orders-by-insertion-id` in the golden dataset is a real
   * failure this application is meant to be able to produce, so the tie-break has
   * to be defined rather than left to SQLite.
   */
  it('breaks a tie by insertion order', async () => {
    await post('/api/tasks', { title: 'earlier', position: 1 })
    await post('/api/tasks', { title: 'later', position: 1 })

    const titles = ((await api('/api/tasks')).body as ListBody).tasks.map((t) => t.title)
    expect(titles).toEqual(['earlier', 'later'])
  })
})

describe('the seed', () => {
  it('produces the same ids and the same order every time', () => {
    const first = seed(db).map((task) => ({ id: task.id, title: task.title }))
    const second = seed(db).map((task) => ({ id: task.id, title: task.title }))
    expect(second).toEqual(first)
    expect(first[0]?.id).toBe(1)
  })

  /**
   * A seed on the wall clock makes every snapshot depend on when the suite ran,
   * and the failures look exactly like the flakiness this project classifies —
   * except they would be the fixture's fault, which is the one kind of noise the
   * dataset must not contain.
   */
  it('uses a fixed timestamp rather than the clock', () => {
    expect(seed(db).map((task) => task.createdAt)).toEqual(SEED.map(() => SEED_TIME))
  })

  it('leaves one task completed, so a status filter has something to hide', () => {
    expect(seed(db).filter((task) => task.status === 'completed')).toHaveLength(1)
  })

  it('replaces whatever was there rather than appending', () => {
    seed(db)
    expect(seed(db)).toHaveLength(SEED.length)
  })
})

/**
 * The one thing a 500 must not do is explain itself.
 *
 * Express's default handler renders the stack into the response body, which on
 * an application whose failures are meant to be *read by an AI triage agent*
 * would put a server stack trace into a prompt and into a public PR comment.
 */
describe('when something unexpected breaks', () => {
  it('answers 500 without leaking the stack', async () => {
    const broken = createApp({
      db: {
        prepare: () => {
          throw new Error('the disk is on fire at /Users/someone/secrets')
        },
      } as unknown as Db,
    })
    const listening = broken.listen(0)
    const brokenPort = (listening.address() as { port: number }).port

    try {
      const response = await fetch(`http://127.0.0.1:${String(brokenPort)}/api/tasks`)
      expect(response.status).toBe(500)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({
        error: { code: 'internal', message: 'something went wrong' },
      })
      expect(body).not.toContain('disk is on fire')
      expect(body).not.toContain('/Users/')
    } finally {
      await new Promise<void>((resolve) => listening.close(() => resolve()))
    }
  })
})

/**
 * E2E setup time is paid on every run, by every spec, forever. A server that
 * takes three seconds to come up is three seconds added to the feedback loop the
 * whole project is about shortening — so the budget is asserted rather than
 * assumed.
 */
describe('starting up', () => {
  it('binds and answers in well under a second', async () => {
    const started = Date.now()
    const running = serve({ port: 0, database: ':memory:', reseed: true, log: () => undefined })

    const response = await fetch(`http://127.0.0.1:${String(running.port)}/api/tasks`)
    const elapsed = Date.now() - started
    const body = (await response.json()) as ListBody

    await running.close()

    expect(body.tasks).toHaveLength(SEED.length)
    expect(elapsed).toBeLessThan(1000)
  })

  it('picks a free port when asked for one, so a running dev server is not a failure', async () => {
    const a = serve({ port: 0, database: ':memory:', log: () => undefined })
    const b = serve({ port: 0, database: ':memory:', log: () => undefined })
    expect(a.port).not.toBe(b.port)
    await Promise.all([a.close(), b.close()])
  })
})
