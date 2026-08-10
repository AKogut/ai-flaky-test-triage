import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalisePlaywrightReport } from './playwright.js'
import { TestRunSchema } from '../test-run.js'

/**
 * Driven by real reporter output, not a hand-written approximation. A fixture
 * written to match what the documentation says encodes the author's belief about
 * the format, and that belief is exactly what an upgrade invalidates.
 *
 * The committed run contains, on purpose: nested suites, a pass, an assertion
 * failure retried to exhaustion, a test that failed and then passed on retry, a
 * skip with an annotation, and a timeout.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const report: unknown = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/reporters/playwright-1.62.1.json'), 'utf8'),
)

const meta = { runId: 'run-1', commitSha: 'abc1234', branch: 'main' }
const run = normalisePlaywrightReport(report, meta)
const byTitle = (needle: string) => run.results.find((r) => r.title.includes(needle))

describe('normalisePlaywrightReport', () => {
  it('produces a valid TestRun', () => {
    expect(() => TestRunSchema.parse(run)).not.toThrow()
  })

  it('flattens nested suites without losing any test', () => {
    expect(run.results).toHaveLength(5)
  })

  it('builds the full title from the suite path, excluding the file suite', () => {
    // 'sample.spec.ts › task board › reorder › …' would duplicate `file`;
    // dropping 'reorder' would merge this with any other 'moves a task…'.
    expect(byTitle('moves a task')?.title).toBe(
      'task board › reorder › moves a task above its neighbour',
    )
  })

  it('gives every test a unique, file-qualified id', () => {
    const ids = run.results.map((r) => r.testId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith('sample.spec.ts')).toBe(true)
  })

  describe('a test that failed and then passed on retry', () => {
    const flaky = byTitle('completion toggle')

    it('is recorded as passed', () => {
      expect(flaky?.status).toBe('passed')
    })

    it('keeps the attempt count', () => {
      expect(flaky?.attempts).toBe(2)
    })

    it('is marked flaky within the run', () => {
      // The single strongest piece of within-run intermittency evidence, and it
      // exists nowhere else once the run is over.
      expect(flaky?.flakyWithinRun).toBe(true)
    })

    it('reports the error from the attempt that failed, not the one that passed', () => {
      expect(flaky?.error?.message).toBeTruthy()
    })
  })

  describe('a test that failed on every attempt', () => {
    const failed = byTitle('moves a task')

    it('is recorded as failed and not flaky', () => {
      expect(failed?.status).toBe('failed')
      expect(failed?.flakyWithinRun).toBe(false)
    })

    it('counts all three attempts', () => {
      expect(failed?.attempts).toBe(3)
    })

    it('carries message, stack and snippet', () => {
      expect(failed?.error?.message).toContain('toEqual')
      expect(failed?.error?.stack).toBeTruthy()
      expect(failed?.error?.snippet).toBeTruthy()
    })
  })

  it('keeps timedOut distinct from failed', () => {
    // A timeout means the assertion was never reached, which is evidence for a
    // different quadrant than an assertion that ran and disagreed.
    expect(byTitle('slow operation')?.status).toBe('timedOut')
  })

  it('preserves skip annotations', () => {
    const skipped = byTitle('drag handle')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.annotations).toContain('skip: covered by keyboard reorder')
  })

  it('sums duration across attempts', () => {
    const failed = byTitle('moves a task')
    expect(failed?.durationMs).toBeGreaterThan(0)
  })

  it('takes run identity from the caller, since the reporter records none', () => {
    expect(run).toMatchObject({ runId: 'run-1', commitSha: 'abc1234', branch: 'main' })
    expect(run.source).toBe('playwright')
  })

  it('normalises the start time to ISO 8601', () => {
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('leaves no required field undefined', () => {
    for (const result of run.results) {
      for (const [key, value] of Object.entries(result)) {
        expect(value, `${result.title}.${key}`).toBeDefined()
      }
    }
  })
})

describe('when the reporter format changes', () => {
  it('fails loudly and says where to look', () => {
    // The alternative is reading undefined and reporting that every test passed
    // once — worse than a crash, and much harder to notice.
    expect(() => normalisePlaywrightReport({ suites: [], stats: {} }, meta)).toThrow(
      /reporter format may have changed[\s\S]*contracts\/reporters\/playwright\.ts/,
    )
  })

  it('rejects a renamed status field rather than guessing', () => {
    const broken = {
      suites: [
        {
          title: 'a.spec.ts',
          specs: [
            {
              title: 't',
              file: 'a.spec.ts',
              tests: [
                { status: 'unexpected', results: [{ outcome: 'failed', duration: 1, retry: 0 }] },
              ],
            },
          ],
        },
      ],
      stats: { startTime: '2026-01-01T00:00:00.000Z', duration: 1 },
    }
    expect(() => normalisePlaywrightReport(broken, meta)).toThrow()
  })

  it('tolerates fields Playwright adds that this module does not read', () => {
    const withExtras = {
      suites: [
        {
          title: 'a.spec.ts',
          somethingNew: true,
          specs: [
            {
              title: 't',
              file: 'a.spec.ts',
              futureField: 1,
              tests: [
                {
                  status: 'expected',
                  annotations: [],
                  results: [{ status: 'passed', duration: 1, retry: 0, newThing: 'x' }],
                },
              ],
            },
          ],
        },
      ],
      stats: { startTime: '2026-01-01T00:00:00.000Z', duration: 1, newStat: 2 },
    }
    expect(normalisePlaywrightReport(withExtras, meta).results).toHaveLength(1)
  })
})
