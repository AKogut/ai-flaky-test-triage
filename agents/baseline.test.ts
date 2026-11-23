import type { ClassificationInput } from '@sentra/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { classifyWithBaseline, isTestPath } from './baseline.js'

/**
 * The path rules as they were, each one alternation, kept as the reference the
 * pairs of expressions are checked against. Do not tidy them: they are the spec.
 *
 * Each alternative is bracketed. That changes nothing, since `|` binds loosest
 * and an alternative already runs to the next `|`, and it keeps these copies
 * from being the exact pattern the precedence check flags.
 */
const TEST_PATH_BEFORE = /(?:(^|\/)(tests?|__tests__|e2e|spec)\/)|(?:\.(test|spec)\.[cm]?[jt]sx?$)/
const NOT_PRODUCT_BEFORE = /(?:^(\.github|docs|wiki)\/)|(?:\.config\.[cm]?js$)/
const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|sql|css|html)$/i

const isProductBefore = (path: string): boolean =>
  path !== '' &&
  SOURCE_EXTENSION.test(path) &&
  !TEST_PATH_BEFORE.test(path) &&
  !NOT_PRODUCT_BEFORE.test(path)

/**
 * Repository paths built from the pieces both rules look for: test and
 * non-product directories at the start and further in, test and config names,
 * and extensions in both cases. No whitespace, so a path survives a diff header.
 */
const repositoryPath = fc.string({
  unit: fc.constantFrom(
    ...['tests/', 'test/', '__tests__/', 'e2e/', 'spec/', 'specs/', 'e2e', 'tests'],
    ...['.github/', 'docs/', 'wiki/', 'docs', 'app/', 'src/', '/', 'a', '-', '_', '.'],
    ...['.test', '.spec', '.config', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.TS'],
    ...['.sql', '.css', '.html', '.md', 'c', 'm', 'x'],
  ),
  maxLength: 8,
})

/** A failure whose only signal is a one-file diff, so the product rule decides it. */
const withDiff = (path: string): ClassificationInput => ({
  historyAvailable: true,
  diff: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-a\n+b`,
  subject: {
    result: {
      testId: 'app/board.spec.ts›renders',
      title: 'renders',
      file: 'app/board.spec.ts',
      status: 'failed',
      attempts: 1,
      flakyWithinRun: false,
      durationMs: 10,
      annotations: [],
      error: { message: 'expected 3 to equal 4' },
    },
    signal: {
      testId: 'app/board.spec.ts›renders',
      flakinessScore: 0.1,
      consecutiveFailures: 0,
      totalRuns: 20,
      firstSeenAt: '2026-06-01T00:00:00.000Z',
      lastPassedAt: '2026-08-01T00:00:00.000Z',
      statusHistory: 'PPPPF',
      isNew: false,
    },
  },
})

describe('the path rules, as pairs of expressions', () => {
  it('call a path a test exactly when the single expression did', () => {
    fc.assert(
      fc.property(repositoryPath, (path) => {
        expect(isTestPath(path)).toBe(TEST_PATH_BEFORE.test(path))
      }),
      { numRuns: 5_000 },
    )
  })

  it('let a one-file diff fire the product rule exactly when they did before', () => {
    fc.assert(
      fc.property(repositoryPath, (path) => {
        const { evidence } = classifyWithBaseline(withDiff(path))
        expect(evidence.includes(`diff touches ${path}`)).toBe(isProductBefore(path))
      }),
      { numRuns: 5_000 },
    )
  })

  it.each([
    ['tests/board.ts', true],
    ['app/__tests__/board.ts', true],
    ['app/board.spec.tsx', true],
    ['latest/board.ts', false],
    ['app/board.spec.ts.snap', false],
  ])('reads %s as a test: %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected)
  })

  it.each([
    ['docs/build.ts', false],
    ['app/docs/build.ts', true],
    ['vite.config.mjs', false],
    ['app/config.mjs', true],
  ])('reads %s as product source: %s', (path, expected) => {
    const { evidence } = classifyWithBaseline(withDiff(path))
    expect(evidence.includes(`diff touches ${path}`)).toBe(expected)
  })
})
