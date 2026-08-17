/**
 * Seeded, reproducible latency injection. Off unless asked for.
 *
 * This is the difference between flakiness that is *scripted* and flakiness that
 * is *emergent*. A test with a random sleep in it is not a flaky test — it is a
 * test that fails on purpose, and it poses a classification problem that is
 * trivially easy and not worth solving. Delaying the *server* changes the
 * interleaving of requests the client already makes, and the failure that comes
 * out is the application's own.
 *
 * **Seeded, not random.** Two reasons, and both are about being able to use the
 * result: a failure has to be reproducible to be debugged, and the golden
 * dataset needs specific interleavings captured deterministically (#56). A
 * random delay gives a failure nobody can get back.
 *
 * **Server-side only.** Nothing is injected into test code. A spec that sleeps is
 * a spec that says what it expects to happen; the point here is that the spec
 * says nothing and the race happens anyway.
 *
 * **Off by default, and asserted to be.** Left on, every run becomes noise and
 * the suite stops meaning anything.
 *
 * ## The seed that reproduces the reorder race
 *
 * `SENTRA_CHAOS=37`. On the request sequence a session actually makes — load the
 * list, then two drags — it delays the first reorder by 399ms and the second by
 * 11ms. Any two drags less than about 350ms apart therefore have their responses
 * arrive in the wrong order, which is the interleaving documented on `move` in
 * `app/client/useTasks.ts`. A test pins those numbers, because a documented
 * reproduction that quietly stops reproducing is worse than none: somebody
 * follows it, sees nothing happen, and concludes the bug was fixed.
 */

/** Per-endpoint delay ranges, in milliseconds. */
export interface Profile {
  min: number
  max: number
}

/**
 * What each endpoint can be delayed by.
 *
 * Reordering gets the widest range because it is the one the race needs: two
 * reorders whose delays differ by more than the gap between the clicks is
 * exactly the interleaving in `useTasks.move`. Reads are delayed a little so a
 * spec cannot rely on the list being instant, and health is never delayed at all
 * — it is what a dev command waits on to know the server is up, and delaying it
 * would slow every start for no signal.
 */
export const PROFILE: Readonly<Record<string, Profile>> = {
  'PATCH /api/tasks/reorder': { min: 0, max: 400 },
  'PATCH /api/tasks/:id/complete': { min: 0, max: 250 },
  'PATCH /api/tasks/:id': { min: 0, max: 150 },
  'POST /api/tasks': { min: 0, max: 150 },
  'DELETE /api/tasks/:id': { min: 0, max: 150 },
  'GET /api/tasks': { min: 0, max: 60 },
}

export const DEFAULT_PROFILE: Profile = { min: 0, max: 0 }

/**
 * A 32-bit mulberry generator.
 *
 * Small, well-known, and — the part that matters here — entirely reproducible
 * from its seed. `Math.random` cannot be seeded, and a dependency for eight
 * lines would be one more thing to rule out when a test goes flaky.
 */
export function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ChaosEnv {
  SENTRA_CHAOS?: string | undefined
}

/**
 * The seed, or null for off.
 *
 * Any value that is not a whole number is off rather than an error. This is a
 * debugging switch, and refusing to start because somebody typed `SENTRA_CHAOS=`
 * would be a worse failure than ignoring it — but `SENTRA_CHAOS=0` is a valid
 * seed and must not be read as "false".
 */
export function seedFrom(env: ChaosEnv): number | null {
  const raw = env.SENTRA_CHAOS
  if (raw === undefined || raw.trim() === '') return null

  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export interface Chaos {
  enabled: boolean
  seed: number | null
  /** Milliseconds to delay this request. Always 0 when disabled. */
  delay: (route: string) => number
}

export const OFF: Chaos = { enabled: false, seed: null, delay: () => 0 }

/**
 * A chaos source for one process.
 *
 * The generator is shared across routes and advances once per delayed request,
 * so the *sequence* of delays is what the seed fixes — which is the thing a
 * reproduction needs. Per-route generators would make a delay depend on how many
 * requests of that kind came before it, and two runs that differ by one extra
 * `GET` would diverge.
 */
export function chaosFrom(env: ChaosEnv): Chaos {
  const seed = seedFrom(env)
  if (seed === null) return OFF

  const random = generator(seed)
  return {
    enabled: true,
    seed,
    delay: (route) => {
      const { min, max } = PROFILE[route] ?? DEFAULT_PROFILE
      return Math.round(min + random() * (max - min))
    },
  }
}
