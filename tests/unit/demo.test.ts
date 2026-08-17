import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMO_DIR, main, OUTPUT, pick } from '../../scripts/demo.js'

/**
 * The demo, exercised the way a stranger runs it.
 *
 * This is the README's headline claim, so the tests are about the claim rather
 * than about the code: it finishes, it writes a real report, it says what it
 * ran, and it does not touch the network. The last one is asserted rather than
 * assumed — a demo that quietly reached the API would still look like it worked,
 * right up until somebody without a key tried it.
 */

const written = new Map<string, string>()

const run = (over: Parameters<typeof main>[0] = {}): Promise<number> =>
  main({
    env: { SENTRA_REPLAY: '1' },
    write: (path, contents) => void written.set(path, contents),
    log: () => undefined,
    ...over,
  })

afterEach(() => {
  written.clear()
  vi.restoreAllMocks()
})

describe('running the demo', () => {
  it('completes and writes a report', async () => {
    expect(await run()).toBe(0)
    expect(written.get(OUTPUT)).toContain('# Flaky-test triage')
  })

  /**
   * Asserted, not assumed. `fetch` is what the SDK reaches for, so replacing it
   * with a throwing stub turns "no network" from a property of the environment
   * into a property of the code.
   */
  it('makes no network call', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the demo reached the network')
    })
    expect(await run()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  /**
   * The stronger version of the same claim: force the agent path with a cassette
   * count, and replay still cannot fall through to a live request. It fails with
   * a miss instead — which is the behaviour that makes a credential-free run
   * trustworthy rather than lucky.
   */
  it('cannot reach the network even on the agent path', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the demo reached the network')
    })
    await expect(run({ cassettes: () => 3 })).rejects.toThrow(/no cassette for/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finishes well inside the thirty seconds the demo promises', async () => {
    const started = Date.now()
    await run()
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  it('classifies every failing and newly-unstable test in the bundle', async () => {
    await run()
    const report = written.get(OUTPUT) ?? ''
    expect(report).toContain('4 failing or newly-unstable test(s)')
    // The passing tests are not in the report; there is nothing to triage about them.
    expect(report).not.toContain('rejects an empty title')
  })

  it('says which classifier ran and links the accuracy of it', async () => {
    await run()
    const report = written.get(OUTPUT) ?? ''
    expect(report).toContain('**baseline** classifier')
    expect(report).toContain('eval/report.md')
    expect(report).toContain('advisory')
  })

  /**
   * A renamed file or a shallow checkout produces this in production too. The
   * bundle then says the source is unavailable rather than pretending it was
   * read and found unremarkable.
   */
  it('carries on when a test source is not on disk', async () => {
    const read = (path: string): string => {
      if (path.includes('sources')) throw new Error('ENOENT')
      return readFileSync(path, 'utf8')
    }
    expect(await run({ read })).toBe(0)
    expect(written.get(OUTPUT)).toContain('# Flaky-test triage')
  })

  it('quotes the evidence each verdict rests on', async () => {
    await run()
    expect(written.get(OUTPUT)).toContain('Evidence the classifier says it relied on')
  })

  it('explains what replay does and does not prove', async () => {
    const lines: string[] = []
    await run({ log: (message) => lines.push(message) })
    expect(lines.join('\n')).toContain('Replay proves the plumbing')
    expect(lines.join('\n')).toContain('not what the model would say')
  })
})

describe('which classifier the demo can run', () => {
  it('replays recorded responses when there are any', () => {
    expect(pick('replay', 12)).toMatchObject({ classifier: 'agent' })
    expect(pick('replay', 12).why).toContain('no network, no key, no cost')
  })

  /**
   * The one thing this script exists not to do is fail on a clean clone. Until
   * the first recorded evaluation lands there are no cassettes, so it runs the
   * heuristic and says so — a degraded run that announces itself is worth more
   * than a broken one, and far more than a polished one that quietly ran
   * something else.
   */
  it('falls back to the baseline rather than failing when there are none', () => {
    expect(pick('replay', 0)).toMatchObject({ classifier: 'baseline' })
    expect(pick('replay', 0).why).toContain('no cassettes are recorded yet')
  })

  it('says plainly when a run will cost money', () => {
    expect(pick('live', 0).why).toContain('costs money')
    expect(pick('record', 0).why).toContain('costs money')
  })
})

describe('the bundled run', () => {
  it('is committed, so a clean clone has something to classify', () => {
    const analysis = JSON.parse(readFileSync(`${DEMO_DIR}/analysis.json`, 'utf8')) as {
      tests: unknown[]
    }
    expect(analysis.tests.length).toBeGreaterThan(4)
    expect(readFileSync(`${DEMO_DIR}/diff.patch`, 'utf8')).toContain('diff --git')
  })

  /**
   * Not decoration. The bundle carries the two cases the project is about — a
   * product race that looks like a flaky test, and a stale selector that looks
   * like a regression — so the demo shows the problem even when the classifier
   * on it is the weak one.
   */
  it('contains the failures worth arguing about', () => {
    const analysis = readFileSync(`${DEMO_DIR}/analysis.json`, 'utf8')
    expect(analysis).toContain('completing a task while its title is saved keeps both changes')
    expect(analysis).toContain('EADDRINUSE')
    expect(analysis).toContain('filter-completed')
  })
})
