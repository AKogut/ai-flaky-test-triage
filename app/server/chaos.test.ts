import { describe, expect, it } from 'vitest'
import { createApp, pattern } from './app.js'
import { chaosFrom, generator, OFF, PROFILE, seedFrom } from './chaos.js'
import { open, type Db } from './db.js'

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
})
