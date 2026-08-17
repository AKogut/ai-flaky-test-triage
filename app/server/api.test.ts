import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from './app.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { create, list, open, reorder, type Db } from './db.js'
import { serve } from './index.js'
import { seed, SEED, SEED_TIME } from './seed.js'

/**
 * The API over real HTTP, on a real port, against its own database.
 *
 * Not because a request object could not be faked, but because everything that
 * consumes this API — the client, the Playwright specs, the flaky ones
 * especially — reaches it that way. A test that calls the handler directly
 * verifies the handler; the interesting failures in an app that exists to be
 * flaky live in the layer above it: status codes, JSON parsing, what a malformed
 * body does.
 *
 * **A file per test, not one shared `:memory:` database.** Two reasons, and the
 * second is the one that mattered:
 *
 * 1. Shared state between tests is the mechanism behind #54 — a spec that fails
 *    because a different spec left something behind. Demonstrating that failure
 *    deliberately in the E2E suite while tolerating it accidentally in the unit
 *    suite would be an odd position for this repository to hold. Deleting every
 *    row between tests is not isolation; it is cleanup that has to be remembered,
 *    and `id` sequences, WAL state and open handles survive it.
 * 2. `:memory:` silently ignores `journal_mode = WAL`. It reports `memory` and
 *    carries on, so every concurrency assertion here used to run against a
 *    journal mode the application never uses in production. A file gets the
 *    pragma the server actually sets.
 *
 * `listen(0)` for the port. Hard-coding one would make this suite fail whenever
 * a dev server was running, which is a flaky test with a very boring cause — in
 * a repository about flaky tests.
 */

/**
 * Longer than the five-second default, and for the reason #55 is about.
 *
 * This file opens a file-backed SQLite database and an HTTP listener per test —
 * around seventy of each — and it is the control group, so a failure here is
 * supposed to mean the API is wrong. Twice during this milestone it failed
 * instead because the machine was busy running something else: once on the
 * health route, once on a reorder. Nothing was wrong with the API either time.
 *
 * A default that fits a quiet machine is an assumption about machine speed, and
 * a spec in this repository has a whole file explaining why that is a defect
 * rather than bad luck. Sixty seconds is far past anything the API can
 * legitimately take, so a test that reaches it is genuinely stuck.
 */
vi.setConfig({ testTimeout: 60_000 })

/** One directory for the whole file, removed once. Per-test dirs are 84 syscalls for nothing. */
const workspace = mkdtempSync(join(tmpdir(), 'taskflow-api-'))
let opened = 0

let db: Db
let server: Server
let base: string

beforeEach(() => {
  opened += 1
  db = open(join(workspace, `run-${String(opened)}`, 'tasks.db'))
  server = createApp({ db, now: () => SEED_TIME }).listen(0)
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
})

/**
 * The whole tree at once. Closing a WAL database leaves `-wal` and `-shm`
 * beside it, so removing only the files this suite named would leave two
 * behind per test in the system temp directory, forever.
 */
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

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
  task: {
    id: number
    title: string
    description: string
    status: string
    position: number
    createdAt: string
    updatedAt: string
  }
}
interface ListBody {
  tasks: TaskBody['task'][]
}

/**
 * Isolation, asserted rather than assumed.
 *
 * A fixture that quietly stops isolating is the worst kind of broken: nothing
 * fails, tests simply start depending on each other, and the failure arrives
 * months later as an ordering-dependent flake in the one suite that is supposed
 * to be the control group. So the first test writes a row with a known id and
 * the second checks it is not there — which only passes if `beforeEach` really
 * did hand over a different database.
 */
describe('each test gets its own database', () => {
  it('writes a row that the next test must not see', async () => {
    const created = (await post('/api/tasks', { title: 'left behind' })).body as TaskBody
    expect(created.task.id).toBe(1)
  })

  it('starts from an empty table and an unused id sequence', async () => {
    expect((await api('/api/tasks')).body).toEqual({ tasks: [] })
    const created = (await post('/api/tasks', { title: 'fresh' })).body as TaskBody
    // AUTOINCREMENT keeps a high-water mark, so a reused database would hand
    // out 2 here even after every row was deleted.
    expect(created.task.id).toBe(1)
  })

  /** WAL is the mode the server sets; `:memory:` reports `memory` and ignores it. */
  it('runs in the journal mode the application actually configures', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })
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

  /**
   * A body that validates and an id that does not.
   *
   * The two are checked in that order, so the schema passes and the id is what
   * fails — the path where a `NaN` reaching the database turns a 404 into a 500,
   * and a 500 in this application ends up as an unexplained failure in a
   * Playwright trace that somebody has to triage.
   */
  it.each([
    ['a patch', '/api/tasks/abc', { title: 'ghost' }],
    ['a completion', '/api/tasks/abc/complete', {}],
  ])(
    '404s rather than 500s for %s addressed to an id that is not a number',
    async (_c, path, b) => {
      const response = await patch(path, b)
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ error: { code: 'not_found' } })
    },
  )
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

  it('404s for an id that is not a number, rather than deleting by NaN', async () => {
    await post('/api/tasks', { title: 'still here' })
    expect((await api('/api/tasks/abc', { method: 'DELETE' })).status).toBe(404)
    expect(((await api('/api/tasks')).body as ListBody).tasks).toHaveLength(1)
  })
})

/**
 * The clock, when nobody injects one.
 *
 * Every other test in this file pins `now`, which is what makes the assertions
 * readable — and which is also how the default came to be the one line no test
 * exercised. A default nothing runs is a default nobody has checked, and this
 * one stamps every row the running server writes.
 */
describe('the timestamp the server writes when it is not told what time it is', () => {
  it('records a real, current, ISO-8601 instant', async () => {
    const own = createApp({ db }).listen(0)
    const port = (own.address() as { port: number }).port

    try {
      const before = Date.now()
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'what time is it' }),
      })
      const { task } = (await response.json()) as TaskBody

      expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
      const stamped = Date.parse(task.createdAt)
      expect(stamped).toBeGreaterThanOrEqual(before - 1000)
      expect(stamped).toBeLessThanOrEqual(Date.now() + 1000)
      expect(task.updatedAt).toBe(task.createdAt)
    } finally {
      await new Promise<void>((resolve) => own.close(() => resolve()))
    }
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

/**
 * The failure `npm run dev` hit on a clean clone, and the reason it survived a
 * full suite: every other test here opens `:memory:`, which needs no directory.
 * SQLite creates the file and refuses to create the folder above it.
 */
describe('opening a database file', () => {
  it('creates the directory it was pointed at', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'taskflow-')), 'nested', 'deeper', 'tasks.db')
    expect(existsSync(dirname(path))).toBe(false)

    const file = open(path)
    try {
      expect(existsSync(path)).toBe(true)
      expect(list(file)).toEqual([])
    } finally {
      file.close()
    }
  })

  it('needs no directory for an in-memory database', () => {
    const memory = open(':memory:')
    expect(list(memory)).toEqual([])
    memory.close()
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

  /**
   * Two, not one. Every row renders the same status label, so two completed rows
   * make a text locator match two elements under `?filter=completed` and one
   * under no filter — the strict-mode ambiguity #53 needs, arriving from the
   * data rather than from timing.
   */
  it('leaves two tasks completed, so a filtered list can show duplicate text', () => {
    expect(seed(db).filter((task) => task.status === 'completed')).toHaveLength(2)
  })

  it('gives two tasks titles with a shared prefix, so a partial locator is ambiguous', () => {
    const reviews = seed(db).filter((task) => task.title.startsWith('Review the'))
    expect(reviews).toHaveLength(2)
    expect(reviews.filter((task) => task.status === 'completed')).toHaveLength(1)
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

  it('says where it is listening and which database it opened', async () => {
    const said: string[] = []
    const running = serve({ port: 0, database: ':memory:', log: (m) => said.push(m) })
    await running.close()

    expect(said.join('\n')).toContain(String(running.port))
    expect(said.join('\n')).toContain(':memory:')
  })

  /**
   * The announcement is not decoration. A server quietly injecting latency makes
   * every test in the suite suspect, and the seed printed here is the only way
   * back to a reproduction — so it is asserted rather than left to the reader of
   * `index.ts`.
   */
  it('announces the chaos seed when the environment sets one', async () => {
    const previous = process.env.SENTRA_CHAOS
    process.env.SENTRA_CHAOS = '284549'
    const said: string[] = []

    try {
      const running = serve({ port: 0, database: ':memory:', log: (m) => said.push(m) })
      await running.close()
    } finally {
      if (previous === undefined) delete process.env.SENTRA_CHAOS
      else process.env.SENTRA_CHAOS = previous
    }

    expect(said.join('\n')).toContain('SENTRA_CHAOS=284549')
  })

  it('says nothing about chaos when the environment has not asked for any', async () => {
    const said: string[] = []
    const running = serve({ port: 0, database: ':memory:', log: (m) => said.push(m) })
    await running.close()
    expect(said.join('\n')).not.toContain('SENTRA_CHAOS')
  })

  /**
   * `SENTRA_DB` and `PORT`, which is how the dev command and CI point the server
   * somewhere other than the default — and the only reason `serve()` reads the
   * environment at all.
   */
  it('takes the database path and the port from the environment', async () => {
    const before = { db: process.env.SENTRA_DB, port: process.env.PORT }
    const path = join(workspace, 'from-the-environment', 'tasks.db')
    process.env.SENTRA_DB = path
    process.env.PORT = '0'

    try {
      const running = serve({ log: () => undefined })
      await running.close()
      expect(existsSync(path)).toBe(true)
    } finally {
      for (const [key, value] of [
        ['SENTRA_DB', before.db],
        ['PORT', before.port],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('reordering', () => {
  const titles = async (): Promise<string[]> =>
    ((await api('/api/tasks')).body as ListBody).tasks.map((t) => t.title)

  const three = async (): Promise<Record<string, number>> => {
    const ids: Record<string, number> = {}
    for (const title of ['a', 'b', 'c']) {
      ids[title] = ((await post('/api/tasks', { title })).body as TaskBody).task.id
    }
    return ids
  }

  it('moves a task to the front', async () => {
    const ids = await three()
    await patch('/api/tasks/reorder', { id: ids.c, index: 0 })
    expect(await titles()).toEqual(['c', 'a', 'b'])
  })

  it('moves a task to the end', async () => {
    const ids = await three()
    await patch('/api/tasks/reorder', { id: ids.a, index: 2 })
    expect(await titles()).toEqual(['b', 'c', 'a'])
  })

  it('moves a task into the middle', async () => {
    const ids = await three()
    await patch('/api/tasks/reorder', { id: ids.c, index: 1 })
    expect(await titles()).toEqual(['a', 'c', 'b'])
  })

  it('returns the resulting order rather than the moved row', async () => {
    const ids = await three()
    const response = await patch('/api/tasks/reorder', { id: ids.c, index: 0 })
    expect((response.body as ListBody).tasks.map((t) => t.title)).toEqual(['c', 'a', 'b'])
  })

  /** An index past the end is what a drag to the bottom of a list sends. */
  it('clamps an index beyond the end', async () => {
    const ids = await three()
    await patch('/api/tasks/reorder', { id: ids.a, index: 99 })
    expect(await titles()).toEqual(['b', 'c', 'a'])
  })

  it('leaves the order alone when a task is moved where it already is', async () => {
    const ids = await three()
    await patch('/api/tasks/reorder', { id: ids.b, index: 1 })
    expect(await titles()).toEqual(['a', 'b', 'c'])
  })

  it('writes one row, not the whole list', async () => {
    const ids = await three()
    const before = ((await api('/api/tasks')).body as ListBody).tasks
    await patch('/api/tasks/reorder', { id: ids.c, index: 0 })
    const after = ((await api('/api/tasks')).body as ListBody).tasks

    const moved = (position: number, id: number): boolean =>
      before.find((t) => t.id === id)?.position !== position
    expect(after.filter((t) => moved(t.position, t.id)).map((t) => t.id)).toEqual([ids.c])
  })

  it('handles a single task without dividing by nothing', async () => {
    const id = ((await post('/api/tasks', { title: 'only' })).body as TaskBody).task.id
    const response = await patch('/api/tasks/reorder', { id, index: 0 })
    expect(response.status).toBe(200)
    expect(await titles()).toEqual(['only'])
  })

  it('404s for a task that is not there', async () => {
    expect((await patch('/api/tasks/reorder', { id: 999, index: 0 })).status).toBe(404)
  })

  it.each([
    ['a missing index', { id: 1 }],
    ['a negative index', { id: 1, index: -1 }],
    ['a fractional index', { id: 1, index: 1.5 }],
    ['an unknown field', { id: 1, index: 0, animate: true }],
  ])('rejects %s', async (_case, body) => {
    expect((await patch('/api/tasks/reorder', body)).status).toBe(400)
  })

  /**
   * Express matches in declaration order. Registered the other way round, `:id`
   * captures the literal "reorder", the handler cannot parse it as a number, and
   * every reorder answers 404 — a routing bug that reads as a missing task.
   */
  it('is not read as a task id', async () => {
    const ids = await three()
    const response = await patch('/api/tasks/reorder', { id: ids.a, index: 1 })
    expect(response.status).toBe(200)
  })
})

/**
 * The outcomes the issue asks to be written down rather than discovered — and
 * asserted, because a documented behaviour nothing checks is a comment.
 */
describe('reordering under a race', () => {
  const titles = async (): Promise<string[]> =>
    ((await api('/api/tasks')).body as ListBody).tasks.map((t) => t.title)

  const four = async (): Promise<Record<string, number>> => {
    const ids: Record<string, number> = {}
    for (const title of ['a', 'b', 'c', 'd']) {
      ids[title] = ((await post('/api/tasks', { title })).body as TaskBody).task.id
    }
    return ids
  }

  /**
   * Both clients read the same list and both say "put mine at index 1". Applied
   * in sequence, the second index means something different once the first move
   * has landed — so the final order is one neither client painted. This is the
   * race #46 reproduces, and it is genuine product behaviour.
   */
  it('gives an order neither client asked for when both move against a stale read', async () => {
    const ids = await four()

    await Promise.all([
      patch('/api/tasks/reorder', { id: ids.c, index: 1 }),
      patch('/api/tasks/reorder', { id: ids.d, index: 1 }),
    ])

    const order = await titles()
    // Every task is still present exactly once — the race loses intent, not rows.
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'd'])
    // And neither client's picture survives intact: they cannot both be at index 1.
    expect(order.indexOf('c') === 1 && order.indexOf('d') === 1).toBe(false)
  })

  /**
   * Two moves into the same gap compute the same midpoint and store the same
   * position, so order between them falls to `id` rather than to who was later —
   * a client that moved a task after another can find it rendered before it.
   */
  it('breaks a position collision by id, not by who wrote last', async () => {
    const ids = await four()

    // Both computed against the same list: the gap between a and b.
    await patch('/api/tasks/reorder', { id: ids.d, index: 1 })
    const positions = ((await api('/api/tasks')).body as ListBody).tasks
    const target = positions.find((t) => t.id === ids.d)?.position ?? 0

    // c lands on exactly the same position, later in time but earlier by id.
    await patch(`/api/tasks/${String(ids.c)}`, { position: target })

    const order = await titles()
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
  })

  /** A list that reorders itself between reads would swamp the interesting signal. */
  it('returns the same order on repeated reads', async () => {
    await four()
    const reads = await Promise.all([titles(), titles(), titles()])
    expect(reads[1]).toEqual(reads[0])
    expect(reads[2]).toEqual(reads[0])
  })
})

/**
 * The documented limit of fractional positioning, pinned rather than estimated.
 *
 * The gap only halves when each inserted task becomes a neighbour of the next —
 * dragging item after item to just below the same row. Driven against the
 * database rather than over HTTP: fifty-two round trips to assert an arithmetic
 * property would be slow for no extra confidence, and the property belongs to
 * `reorder` rather than to the route.
 */
describe('the limit of halving a gap', () => {
  it('collapses onto the neighbour after 52 insertions below the same row', () => {
    const top = create(db, { title: 'top', position: 1 }, SEED_TIME)
    create(db, { title: 'bottom', position: 2 }, SEED_TIME)

    let inserted = 0
    for (; inserted < 200; inserted++) {
      const task = create(db, { title: `dragged ${String(inserted)}` }, SEED_TIME)
      const after = reorder(db, task.id, 1, SEED_TIME)
      const landed = after?.find((row) => row.id === task.id)?.position ?? 0
      if (landed === top.position) break
    }

    expect(inserted).toBe(52)
  })
})
