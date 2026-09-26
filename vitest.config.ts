import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The quota test generates ~35k rules; give it headroom.
    testTimeout: 30000
  }
});
