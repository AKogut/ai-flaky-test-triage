import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'specs',
  testMatch: '**/*.spec.ts',
  retries: 2,
  preserveOutput: 'always',
  reporter: [['json', { outputFile: 'report.json' }]],
  projects: [{ name: 'chromium' }],
})
