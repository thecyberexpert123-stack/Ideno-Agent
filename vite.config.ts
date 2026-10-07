// `vitest/config` re-exports Vite's defineConfig with the `test` block typed,
// so dev/build and test configuration live in one file.
import { defineConfig } from 'vitest/config';

/**
 * Ideno ships as a static web app: there is no server component, so no secrets
 * and no API keys are ever handled by a backend we control.
 *
 * `host: 0.0.0.0` + `allowedHosts: true` are required so the dev server can be
 * reached through a reverse proxy / preview host instead of only localhost.
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // Puter.js is loaded through a dynamic import so it stays in its own chunk
    // and is never downloaded (or executed) unless the user picks that provider.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
