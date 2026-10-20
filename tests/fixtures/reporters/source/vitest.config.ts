import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['specs/**/*.test.ts'] },
})
