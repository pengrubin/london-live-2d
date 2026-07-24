import { defineConfig } from 'vite';

// data/ holds the pmtiles basemap and (from P1 on) baked route/station JSON.
// Serving it as publicDir keeps large binary data out of frontend/ and out of
// the bundling pipeline. DEV ONLY: for `vite build`, publicDir is disabled —
// otherwise Vite would copy all of data/ (136 MB pmtiles + hundreds of MB of
// bus-traces/osm-cache) into dist/. In production the backend serves data/
// directly and the pmtiles comes from R2 (VITE_PMTILES_URL).
export default defineConfig(({ command }) => ({
  publicDir: command === 'build' ? false : '../data',
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
}));
