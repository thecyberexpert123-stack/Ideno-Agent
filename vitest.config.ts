import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    // Integration tests bind ephemeral HTTP ports and write to temp dirs; a
    // single fork keeps port/tempdir usage predictable without serialising
    // every assertion.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
});
