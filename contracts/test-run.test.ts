import { describe, expect, it } from 'vitest'
import {
  deriveTestId,
  normaliseFilePath,
  parseTestRun,
  TestResultSchema,
  TestRunSchema,
} from './test-run.js'

const result = {
  testId: 'tests/e2e/board.spec.ts›reorder › moves a task up',
  title: 'reorder › moves a task up',
  file: 'tests/e2e/board.spec.ts',
  status: 'failed',
  attempts: 1,
  flakyWithinRun: false,
  durationMs: 1234,
  error: { message: 'expected 2 to be 1' },
}

const run = {
  runId: 'run-1',
  commitSha: 'abc1234',
  branch: 'main',
  startedAt: '2026-08-10T12:00:00.000Z',
  durationMs: 5000,
  source: 'playwright',
  results: [result],
}

describe('deriveTestId', () => {
  it('combines file and title', () => {
    expect(deriveTestId('tests/a.spec.ts', 'does a thing')).toBe('tests/a.spec.ts›does a thing')
  })

  it('gives the same id for paths that differ only by normalisation', () => {
    // Two implementations disagreeing here would split one test's history in
    // two and make every intermittent test look new.
    const canonical = deriveTestId('tests/a.spec.ts', 'x')
    expect(deriveTestId('./tests/a.spec.ts', 'x')).toBe(canonical)
    expect(deriveTestId('tests\\a.spec.ts', 'x')).toBe(canonical)
    expect(deriveTestId('/tests/a.spec.ts', 'x')).toBe(canonical)
    expect(deriveTestId('tests/a.spec.ts', '  x  ')).toBe(canonical)
  })

  it('separates tests with the same title in different files', () => {
    expect(deriveTestId('a.spec.ts', 'works')).not.toBe(deriveTestId('b.spec.ts', 'works'))
  })

  it('separates different titles in the same file', () => {
    expect(deriveTestId('a.spec.ts', 'x')).not.toBe(deriveTestId('a.spec.ts', 'y'))
  })
})

describe('normaliseFilePath', () => {
  it.each([
    ['./a/b.ts', 'a/b.ts'],
    ['/a/b.ts', 'a/b.ts'],
    ['a\\b.ts', 'a/b.ts'],
    ['a/b.ts', 'a/b.ts'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseFilePath(input)).toBe(expected)
  })
})

describe('TestRunSchema', () => {
  it('accepts a well-formed run', () => {
    expect(TestRunSchema.parse(run).results).toHaveLength(1)
  })

  it('round-trips through JSON unchanged', () => {
    const once = TestRunSchema.parse(run)
    expect(TestRunSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('defaults annotations rather than leaving them undefined', () => {
    expect(TestResultSchema.parse(result).annotations).toEqual([])
  })

  it('rejects an unknown field instead of passing it through', () => {
    // A reporter that renames a field must fail here, not three stages later
    // with an undefined that looks like "this test has no error".
    expect(() => TestRunSchema.parse({ ...run, unexpected: true })).toThrow()
  })

  it.each([
    ['attempts below 1', { ...result, attempts: 0 }],
    ['a negative duration', { ...result, durationMs: -1 }],
    ['an unknown status', { ...result, status: 'exploded' }],
    ['an empty file path', { ...result, file: '' }],
  ])('rejects %s', (_label, bad) => {
    expect(() => TestResultSchema.parse(bad)).toThrow()
  })

  it('rejects a non-ISO timestamp', () => {
    expect(() => TestRunSchema.parse({ ...run, startedAt: '10 August 2026' })).toThrow()
  })

  it('rejects a truncated commit sha', () => {
    expect(() => TestRunSchema.parse({ ...run, commitSha: 'abc' })).toThrow()
  })

  it('accepts a run with no results — a green run is valid input', () => {
    expect(TestRunSchema.parse({ ...run, results: [] }).results).toEqual([])
  })
})

describe('parseTestRun', () => {
  it('names the source and the failing path', () => {
    expect(() => parseTestRun({ ...run, commitSha: 'abc' }, 'results.json')).toThrow(
      /results\.json is not a valid TestRun:[\s\S]*commitSha/,
    )
  })

  it('caps how many issues it prints', () => {
    let message = ''
    try {
      parseTestRun({}, 'results.json')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.split('\n').length).toBeLessThanOrEqual(7)
  })
})
