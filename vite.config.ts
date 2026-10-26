import { defineConfig } from 'vite';

// The browser half of the web app. In development, /api is proxied to the
// web backend; in Docker, nginx serves the build and does the same.
export default defineConfig({
    root: 'src/web/frontend',
    build: { outDir: '../../../dist-web', emptyOutDir: true },
    server: {
        port: 5173,
        proxy: { '/api': { target: process.env.WEB_BACKEND_URL ?? 'http://127.0.0.1:3001' } }
    }
});
