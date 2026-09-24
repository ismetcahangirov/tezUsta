import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vitest/config';

/**
 * The admin panel and the API share one origin (ADR-0043 § 4). In production
 * a reverse proxy serves these static files and forwards `/api/*` to the API;
 * in development this dev server plays that role. The API serves `/admin/...`
 * at its root, so the `/api` prefix is stripped on the way through.
 *
 * `changeOrigin` stays off: the API sees the browser's own Host, exactly as it
 * will behind the production proxy.
 */
const API_TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  css: {
    // Inline rather than a postcss.config file: one plugin, and it keeps the
    // whole build definition in the file Vite already reads.
    postcss: { plugins: [tailwindcss()] },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup-dom.ts'],
    // CSS is irrelevant to a behaviour test and PostCSS would only slow it.
    css: false,
  },
});
