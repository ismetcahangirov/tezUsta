import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vitest/config';

/**
 * The master's web subscription page and the API share one origin (ADR-0061
 * § 1), as the admin panel does (ADR-0043 § 4): in production nginx serves
 * these files and forwards `/api/*` to the API; in development this server
 * does. The prefix is stripped on the way through.
 *
 * Port 5174, beside the admin panel's 5173, so both can run at once.
 * `changeOrigin` stays off: the API sees the browser's own Host, exactly as it
 * will behind the production proxy.
 */
const API_TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: { plugins: [tailwindcss()] },
  },
  server: {
    port: 5174,
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
    css: false,
  },
});
