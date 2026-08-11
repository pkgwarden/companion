import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The extension host is not available under vitest, so `vscode` resolves to a hand-rolled
// double; every module that imports it is thin glue over the modules that carry the logic.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/vscodeDouble.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'uat/src/**/*.test.ts'],
  },
})
