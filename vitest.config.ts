import { defineConfig } from 'vitest/config'

/**
 * Where the unit run leaves its machine-readable report.
 *
 * Separate from Playwright's `results.json` rather than sharing it: both would
 * be written by `npm test`, and whichever finished second would silently erase
 * the other's failures. Two files, one merge, no lost run.
 *
 * Exported so a test can assert the file is gitignored rather than trusting
 * that somebody remembered — a pipeline output committed by accident is a diff
 * that changes on every run and stops being read within a week.
 */
export const UNIT_RESULTS = 'results-unit.json'

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'contracts/**/*.test.ts',
      'flakemetry-lib/**/*.test.ts',
      'agents/**/*.test.ts',
      'prompts/**/*.test.ts',
      'eval/**/*.test.ts',
      'app/server/**/*.test.ts',
      'app/client/**/*.test.ts',
      'app/client/**/*.test.tsx',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],

    /**
     * The unit run is a data source, not only a gate.
     *
     * Unit failures classify differently from browser failures — far more often
     * `deterministic`, far more often `app_code` — and a golden dataset built
     * only from Playwright output would teach the classifier that every failure
     * has a locator in it. So the JSON report is emitted on every run and
     * normalised by `normaliseVitestReport`, the same way Playwright's is.
     *
     * **Always on, not behind a flag.** A reporter somebody has to remember to
     * switch on is one CI forgets, and the evidence is gone by the time anyone
     * notices — the run that would have been worth capturing is the run that
     * already finished.
     *
     * `default` stays first so a human still gets a human report; `json` is
     * additional, not instead.
     */
    reporters: ['default', 'json'],
    outputFile: { json: UNIT_RESULTS },

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      /**
       * `scripts/` is no longer excluded wholesale.
       *
       * It was, when it held only glue. It now holds `demo.ts`, which is the
       * README's headline command and therefore product surface — and code
       * nobody measures is code nobody notices breaking.
       *
       * The line is product surface in, repository maintenance out.
       * `changelog.ts` and `status-banner.ts` each have a `--check` mode that CI
       * runs against the committed files, which is a stronger claim about them
       * than a percentage. A script added later is measured by default, which is
       * the safe direction for this list to rot in.
       *
       * `demo/` holds bundled fixture data — the contents of test files in an
       * imaginary repository, read as text and fed to a prompt. Measuring
       * coverage of an input is a category error.
       */
      exclude: [
        '**/dist/**',
        '**/*.config.*',
        '**/scripts/*.mjs',
        '**/scripts/changelog.ts',
        '**/scripts/status-banner.ts',
        'tests/**',
        'demo/**',
      ],

      /**
       * A floor, not a target.
       *
       * Set a few points below what is measured today (97.5% statements, 87.4%
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
        statements: 95,
        branches: 80,
        functions: 95,
        lines: 95,
      },
    },
  },
})
