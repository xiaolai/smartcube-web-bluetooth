import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/**/types.ts'],
      reporter: ['text', 'lcov'],
      // Floor at the measured level; CI runs `test:coverage`, so coverage can only go up.
      thresholds: {
        statements: 87,
        branches: 84,
        functions: 91,
        lines: 87,
      },
    },
  },
});

