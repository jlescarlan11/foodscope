import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: !process.env.TEST_DATABASE_URL,
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
});
