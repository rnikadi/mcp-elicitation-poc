import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is the frontend folder.
export default defineConfig({
    test: { include: ['test/**/*.test.ts'] }
});
