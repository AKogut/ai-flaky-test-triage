import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normaliseVitestReport, toRepositoryPath } from './vitest.js'
import { TestRunSchema } from '../test-run.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const report: unknown = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/reporters/vitest-4.1.10.json'), 'utf8'),
)

const meta = { runId: 'run-1', commitSha: 'abc1234', branch: 'main', repositoryRoot: '/repo' }
const run = normaliseVitestReport(report, meta)
const byTitle = (needle: string) => run.results.find((r) => r.title.includes(needle))

describe('normaliseVitestReport', () => {
  it('produces a valid TestRun indistinguishable in shape from a Playwright one', () => {
    expect(() => TestRunSchema.parse(run)).not.toThrow()
    expect(run.source).toBe('vitest')
  })

  it('keeps every assertion', () => {
    expect(run.results).toHaveLength(4)
  })

  it('rebuilds the title from the ancestor titles rather than trusting fullName', () => {
    // Vitest joins ancestors with a space, so `describe('a') > it('b c')` and
    // `describe('a b') > it('c')` collapse to the same fullName. Rebuilding from
    // the parts keeps them apart — and matches the Playwright separator.
    expect(byTitle('out-of-range')?.title).toBe(
      'task api › reorder › rejects an out-of-range position',
    )
  })

  it('makes paths repository-relative so ids match across machines', () => {
    for (const result of run.results) {
      expect(result.file).toBe('specs/tasks.test.ts')
      expect(result.testId.startsWith('specs/tasks.test.ts')).toBe(true)
    }
  })

  it('splits the assertion message from the stack', () => {
    const failed = byTitle('out-of-range')
    expect(failed?.error?.message).toBe(
      'AssertionError: expected { position: 9 } to deeply equal { position: 1 }',
    )
    expect(failed?.error?.stack).toContain('    at ')
    expect(failed?.error?.message).not.toContain('    at ')
  })

  it('handles a thrown error as well as a failed assertion', () => {
    expect(byTitle('missing task')?.error?.message).toContain('TypeError')
  })

  it('records skipped tests as skipped with no error', () => {
    const skipped = byTitle('bulk delete')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.error).toBeUndefined()
  })

  it('reports one attempt and no within-run flakiness, because Vitest records neither', () => {
    // The absence is information: "we do not know", not "passed first time".
    // Inventing retries here would manufacture confidence on the determinism
    // axis that the data does not support.
    for (const result of run.results) {
      expect(result.attempts).toBe(1)
      expect(result.flakyWithinRun).toBe(false)
    }
  })

  it('leaves no required field undefined', () => {
    for (const result of run.results) {
      for (const [key, value] of Object.entries(result)) {
        expect(value, `${result.title}.${key}`).toBeDefined()
      }
    }
  })
})

describe('toRepositoryPath', () => {
  it.each([
    ['/repo/tests/a.test.ts', '/repo', 'tests/a.test.ts'],
    ['/home/runner/work/repo/tests/a.test.ts', '/home/runner/work/repo', 'tests/a.test.ts'],
    ['/repo/tests/a.test.ts', '/repo/', 'tests/a.test.ts'],
    ['C:\\repo\\tests\\a.test.ts', 'C:/repo', 'tests/a.test.ts'],
  ])('%s under %s -> %s', (absolute, repoRoot, expected) => {
    expect(toRepositoryPath(absolute, repoRoot)).toBe(expected)
  })

  it('leaves a path outside the repository alone rather than mangling it', () => {
    expect(toRepositoryPath('/elsewhere/a.test.ts', '/repo')).toBe('elsewhere/a.test.ts')
  })
})

describe('when the reporter format changes', () => {
  it('fails loudly and says where to look', () => {
    expect(() => normaliseVitestReport({ testResults: [] }, meta)).toThrow(
      /reporter format may have changed[\s\S]*contracts\/reporters\/vitest\.ts/,
    )
  })

  it('tolerates fields Vitest adds that this module does not read', () => {
    const withExtras = {
      startTime: 1_700_000_000_000,
      newTopLevel: true,
      testResults: [
        {
          name: '/repo/a.test.ts',
          somethingNew: 1,
          assertionResults: [
            {
              title: 't',
              fullName: 't',
              ancestorTitles: [],
              status: 'passed',
              failureMessages: [],
              futureField: 'x',
            },
          ],
        },
      ],
    }
    expect(normaliseVitestReport(withExtras, meta).results).toHaveLength(1)
  })
})
