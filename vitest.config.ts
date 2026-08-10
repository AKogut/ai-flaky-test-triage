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
    },
  },
})
