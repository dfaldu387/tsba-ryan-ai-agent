import { defineConfig } from 'vitest/config';

// Unit tests: pure logic only — no database, network or real secrets. The env
// below overrides whatever .env holds (dotenv never overwrites set variables).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: { SESSION_SECRET: 'unit-test-secret-not-used-anywhere-else', STORAGE: 'memory', NODE_ENV: 'test' },
  },
});
