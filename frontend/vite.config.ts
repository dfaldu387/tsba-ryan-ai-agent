import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the backend so the browser stays single-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on all interfaces (IPv4 + IPv6) so the dev server is reachable at
    // 127.0.0.1 and localhost, not just ::1.
    host: true,
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
