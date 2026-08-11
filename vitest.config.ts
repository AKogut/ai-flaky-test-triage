import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'contracts/**/*.test.ts',
      'flakemetry-lib/**/*.test.ts',
      'agents/**/*.test.ts',
      'eval/**/*.test.ts',
      'app/server/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      exclude: ['**/dist/**', '**/*.config.*', 'scripts/**', 'tests/**'],

      /**
       * A floor, not a target.
       *
       * Set a few points below what is measured today (96.6% statements, 82.9%
       * branches) on purpose. A threshold pinned to the current number fails on
       * the first honest refactor that deletes a well-covered file, and a gate
       * that fires on noise is one somebody switches off — at which point the
       * repository has no coverage check at all and everyone still believes it
       * does.
       *
       * Branches sit lower than the rest because the uncovered ones are mostly
       * defensive `?? 0` fallbacks on indexed access that `noUncheckedIndexedAccess`
       * requires and that no input can reach. Chasing those to 95% would mean
       * writing tests for states the type system already excludes.
       *
       * Raise these when a milestone genuinely lifts the number, in the same
       * commit that lifts it.
       */
      thresholds: {
        statements: 93,
        branches: 78,
        functions: 93,
        lines: 93,
      },
    },
  },
})
