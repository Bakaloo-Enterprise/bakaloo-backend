import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    testTimeout: 30000,
    // DB tests share one database and some flip the global feature flags — run files one at a time so they can't interfere.
    fileParallelism: false,
  },
})
