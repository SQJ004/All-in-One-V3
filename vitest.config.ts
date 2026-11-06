import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', ANTHROPIC_API_KEY: '', DISCORD_TOKEN: 'test-token-'.padEnd(40, 'x'), DASHBOARD_ENABLED: 'false' },
  },
});
