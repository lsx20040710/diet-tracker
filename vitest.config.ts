import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'ui',
          environment: 'happy-dom',
          include: ['tests/ui/*.test.ts'],
        },
      },
    ],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
