import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the backend so the browser stays single-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Pin to IPv4 — 'localhost' can resolve to IPv6 (::1), where another dev
      // server may be listening on :8080 and shadow our backend.
      '/api': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
