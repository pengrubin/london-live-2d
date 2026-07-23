import { defineConfig } from 'vite';

// data/ holds the pmtiles basemap and (from P1 on) baked route/station JSON.
// Serving it as publicDir keeps large binary data out of frontend/ and out of
// the bundling pipeline; in production the same files go to R2/Pages assets.
export default defineConfig({
  publicDir: '../data',
  server: {
    port: 5173,
    // Forward API calls to the Fastify backend so frontend code can use
    // relative /api URLs in dev and prod alike.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  // maplibre-gl v5 loads its render worker via a URL relative to the module;
  // Vite's dep pre-bundling breaks that path (maplibre-gl-worker.mjs 404),
  // so keep the package out of optimizeDeps.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
});
