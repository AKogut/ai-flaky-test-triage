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
      thresholds: {
        statements: 87, // 91.89% when the floor was introduced.
        branches: 77, // 83.63% when the floor was introduced.
        functions: 90, // 95.55% when the floor was introduced.
        lines: 88, // 92.42% when the floor was introduced.
      },
    },
  },
})
