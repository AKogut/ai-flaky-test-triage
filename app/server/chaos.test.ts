import { describe, expect, it } from 'vitest'
import { createApp, pattern } from './app.js'
import { chaosFrom, generator, OFF, PROFILE, seedFrom, type Chaos } from './chaos.js'
import { list, open, type Db } from './db.js'
import { seed } from './seed.js'

/**
 * The chaos layer, and the property that makes it worth having.
 *
 * A random sleep would be easier and useless: a failure nobody can reproduce is
 * a failure nobody can debug, and the golden dataset needs specific interleavings
 * captured deterministically. So the interesting assertions here are about
 * *sameness* — the same seed producing the same sequence — and about the layer
 * being off unless it is asked for, because a server quietly injecting latency
 * makes every test in the suite suspect.
 */

describe('the seed', () => {
  it.each([
    ['unset', {}],
    ['empty', { SENTRA_CHAOS: '' }],
    ['whitespace', { SENTRA_CHAOS: '  ' }],
    ['not a number', { SENTRA_CHAOS: 'yes' }],
    ['fractional', { SENTRA_CHAOS: '1.5' }],
    ['negative', { SENTRA_CHAOS: '-1' }],
  ])('is off when %s', (_case, env) => {
    expect(seedFrom(env)).toBeNull()
    expect(chaosFrom(env).enabled).toBe(false)
  })

  /**
   * A debugging switch should not refuse to start over a typo — but zero is a
   * valid seed and must not be read as "false", which is the bug this pins.
   */
  it('treats zero as a seed rather than as off', () => {
    expect(seedFrom({ SENTRA_CHAOS: '0' })).toBe(0)
    expect(chaosFrom({ SENTRA_CHAOS: '0' }).enabled).toBe(true)
  })

  it('reads a whole number', () => {
    expect(chaosFrom({ SENTRA_CHAOS: '4242' })).toMatchObject({ enabled: true, seed: 4242 })
  })
})

describe('when it is off', () => {
  it('delays nothing at all', () => {
    const chaos = chaosFrom({})
    expect(chaos.delay('PATCH /api/tasks/reorder')).toBe(0)
    expect(chaos.delay('GET /api/tasks')).toBe(0)
  })

  it('is the same object shape as when it is on, so nothing branches on presence', () => {
    expect(Object.keys(OFF).sort()).toEqual(Object.keys(chaosFrom({ SENTRA_CHAOS: '1' })).sort())
  })
})

describe('when it is on', () => {
  const sequence = (seed: string, routes: string[]): number[] => {
    const chaos = chaosFrom({ SENTRA_CHAOS: seed })
    return routes.map((route) => chaos.delay(route))
  }

  const REQUESTS = [
    'PATCH /api/tasks/reorder',
    'PATCH /api/tasks/reorder',
    'GET /api/tasks',
    'POST /api/tasks',
  ]

  /** The whole point. A failure that cannot be reproduced cannot be debugged. */
  it('produces the same sequence for the same seed, every time', () => {
    expect(sequence('7', REQUESTS)).toEqual(sequence('7', REQUESTS))
    expect(sequence('7', REQUESTS)).toEqual(sequence('7', REQUESTS))
  })

  it('produces a different sequence for a different seed', () => {
    expect(sequence('7', REQUESTS)).not.toEqual(sequence('8', REQUESTS))
  })

  /**
   * One generator across all routes, advancing once per request. Per-route
   * generators would make a delay depend on how many requests of that kind came
   * before it, so two runs differing by a single extra GET would diverge.
   */
  it('advances one shared sequence, so an extra request shifts what follows', () => {
    const withExtra = sequence('7', ['GET /api/tasks', ...REQUESTS])
    expect(withExtra.slice(1)).not.toEqual(sequence('7', REQUESTS))
  })

  it('stays inside the documented range for each endpoint', () => {
    const chaos = chaosFrom({ SENTRA_CHAOS: '99' })
    for (const [route, { min, max }] of Object.entries(PROFILE)) {
      for (let i = 0; i < 50; i++) {
        const delay = chaos.delay(route)
        expect(delay).toBeGreaterThanOrEqual(min)
        expect(delay).toBeLessThanOrEqual(max)
      }
    }
  })

  /** Reordering needs the widest range: the race is two reorders whose delays differ. */
  it('gives reordering more room than anything else', () => {
    const reorder = PROFILE['PATCH /api/tasks/reorder']?.max ?? 0
    for (const [route, { max }] of Object.entries(PROFILE)) {
      if (route !== 'PATCH /api/tasks/reorder') expect(reorder).toBeGreaterThan(max)
    }
  })

  /** A dev command waits on health to know the server is up. */
  it('never delays a route it has no profile for', () => {
    expect(chaosFrom({ SENTRA_CHAOS: '5' }).delay('GET /api/health')).toBe(0)
  })
})

/**
 * The seed the README tells people to use, pinned so the README cannot rot.
 *
 * A documented reproduction that quietly stops reproducing is worse than none:
 * somebody follows it, sees the bug not happen, and concludes it was fixed.
 */
describe('the seed that reproduces the reorder race', () => {
  const RACE_SEED = '37'

  it('delays the first reorder far longer than the second', () => {
    const chaos = chaosFrom({ SENTRA_CHAOS: RACE_SEED })

    // The sequence a session actually makes: load the list, then two drags.
    chaos.delay('GET /api/tasks')
    const first = chaos.delay('PATCH /api/tasks/reorder')
    const second = chaos.delay('PATCH /api/tasks/reorder')

    expect(first).toBe(399)
    expect(second).toBe(11)

    // The window is what matters: the second response can arrive first as long
    // as the two drags are less than this far apart.
    expect(first - second).toBeGreaterThan(350)
  })
})

describe('the generator', () => {
  it('is reproducible from its seed', () => {
    const a = generator(123)
    const b = generator(123)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('stays inside [0, 1)', () => {
    const random = generator(1)
    for (let i = 0; i < 1000; i++) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('does not get stuck on one value', () => {
    const random = generator(2)
    expect(new Set(Array.from({ length: 20 }, () => random())).size).toBeGreaterThan(15)
  })
})

describe('the route pattern', () => {
  it.each([
    ['/api/tasks', '/api/tasks'],
    ['/api/tasks/reorder', '/api/tasks/reorder'],
    ['/api/tasks/7', '/api/tasks/:id'],
    ['/api/tasks/7/complete', '/api/tasks/:id/complete'],
    ['/api/health', '/api/health'],
  ])('reads %s as %s', (path, expected) => {
    expect(pattern(path)).toBe(expected)
  })

  /**
   * `reorder` is not a number, so it must not be read as an id — which is the
   * same trap the route registration order guards against, arriving here through
   * a different door.
   */
  it('does not mistake reorder for an id', () => {
    expect(pattern('/api/tasks/reorder')).not.toBe('/api/tasks/:id')
  })
})

// ---------------------------------------------------------------------------

describe('the server with chaos on', () => {
  const run = async (
    env: Record<string, string>,
  ): Promise<{ delays: number[]; status: number }> => {
    const db: Db = open(':memory:')
    const delays: number[] = []
    const app = createApp({
      db,
      chaos: chaosFrom(env),
      // Recorded rather than waited on: this asserts that a delay was applied,
      // not that a test can spend real seconds proving it.
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    const server = app.listen(0)
    const port = (server.address() as { port: number }).port
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/tasks`)

    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    return { delays, status: response.status }
  }

  it('delays a request when a seed is set', async () => {
    const { delays, status } = await run({ SENTRA_CHAOS: '11' })
    expect(status).toBe(200)
    expect(delays).toHaveLength(1)
  })

  /** Left on, every run becomes noise and the suite stops meaning anything. */
  it('delays nothing when no seed is set', async () => {
    expect((await run({})).delays).toEqual([])
  })

  it('still answers correctly with chaos on', async () => {
    expect((await run({ SENTRA_CHAOS: '11' })).status).toBe(200)
  })

  /**
   * The distinction the whole layer rests on, and the one it got wrong.
   *
   * Delaying *before* the handler reorders the handlers, and for an index-based
   * reorder that changes what the server computes — the client and the server
   * then agree on an order the user never asked for, and no refresh fixes it.
   * That is a race, but it is not the one `useTasks.move` documents and not the
   * one the golden dataset contains.
   *
   * Delaying the **response** leaves the handlers in the order the client sent
   * them, so the server stays right and only the answers come back inverted.
   * That is the interleaving #52 needs: the database is correct, the screen is
   * not, and the older response is the one that wins.
   *
   * Nothing caught the original because every test asserted on the delay
   * *values*. This one asserts on the consequence.
   */
  it('delays the answer, not the work, so the server applies writes in the order they were sent', async () => {
    const db: Db = open(':memory:')
    const rows = seed(db)
    const first = rows.at(-1)?.id ?? 0
    const second = rows.at(-2)?.id ?? 0

    // The first request's answer is held far longer than the second's, which is
    // the inversion; the numbers are fixed rather than drawn so the test is
    // about ordering rather than about luck.
    const held = [180, 5]
    let call = 0
    const chaos: Chaos = { enabled: true, seed: 1, delay: () => held[call++] ?? 0 }

    const server = createApp({ db, chaos }).listen(0)
    const port = (server.address() as { port: number }).port

    const move = async (id: number): Promise<{ at: number; titles: string[] }> => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/tasks/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, index: 0 }),
      })
      const body = (await response.json()) as { tasks: { title: string }[] }
      return { at: Date.now(), titles: body.tasks.map((task) => task.title) }
    }

    const one = move(first)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const two = move(second)
    const [a, b] = await Promise.all([one, two])

    await new Promise<void>((resolve) => server.close(() => resolve()))

    // The answers came back inverted…
    expect(a.at).toBeGreaterThan(b.at)
    // …but the server applied them in the order they were sent, so the second
    // move is the one on top.
    expect(list(db)[0]?.title).toBe(rows.at(-2)?.title)
    // And the late answer carries the older list — the payload that, applied
    // last, undoes the second move on screen.
    expect(a.titles).not.toEqual(list(db).map((task) => task.title))

    db.close()
  })

  /**
   * `DELETE` answers 204 with no body, so a wrapper that only delayed `json`
   * would have left one route immediate while `PROFILE` claimed otherwise. A
   * profile that lies is worse than no profile.
   */
  it('delays a response that has no body', async () => {
    const db: Db = open(':memory:')
    const rows = seed(db)
    const delays: number[] = []
    const app = createApp({
      db,
      chaos: chaosFrom({ SENTRA_CHAOS: '11' }),
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    const server = app.listen(0)
    const port = (server.address() as { port: number }).port
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/tasks/${String(rows[0]?.id ?? 0)}`,
      { method: 'DELETE' },
    )

    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()

    expect(response.status).toBe(204)
    expect(delays).toHaveLength(1)
  })

  /**
   * Once, with the real timer.
   *
   * Every other test here injects `sleep` and asserts on the number, which keeps
   * the suite fast and is the right trade — but it means the delay the server
   * actually performs is the one line nothing runs. A `sleep` that resolved
   * immediately, or never, would pass all of them and inject no latency at all,
   * and the flaky specs downstream would quietly stop being flaky.
   *
   * Seed 3 on a `GET`, whose profile tops out at 60ms, so this costs
   * milliseconds. The assertion is that time passed at all, with a floor well
   * under the delay — a tight bound would be exactly the fixed-timeout mistake
   * #55 exists to demonstrate.
   */
  it('really waits, when nobody hands it a fake clock', async () => {
    const db: Db = open(':memory:')
    const chaos = chaosFrom({ SENTRA_CHAOS: '3' })
    const delay = chaosFrom({ SENTRA_CHAOS: '3' }).delay('GET /api/tasks')
    expect(delay).toBeGreaterThan(20)

    const server = createApp({ db, chaos }).listen(0)
    const port = (server.address() as { port: number }).port

    const started = process.hrtime.bigint()
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/tasks`)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6

    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()

    expect(response.status).toBe(200)
    expect(elapsed).toBeGreaterThan(delay / 2)
  })
})
