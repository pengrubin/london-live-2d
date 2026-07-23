# London Live — 2D Real-Time Transport Map

A 2D real-time map of all-London public transport (inspired by
[Zone One](https://london.jamespotter.dev/), reimplemented in 2D at
Greater-London scale). MapLibre GL basemap from a self-hosted Protomaps
extract; live vehicle positions inferred from the TfL Unified API.

## Layout

| Path | Purpose |
|------|---------|
| `frontend/` | Vite + TypeScript + MapLibre GL app |
| `backend/` | Node backend: TfL proxy, position inference, WebSocket broadcast (from P2) |
| `data/` | Basemap pmtiles + baked route/station JSON (served as Vite publicDir) |
| `scripts/` | Data baking scripts (TfL route geometry → static JSON) |
| `docs/` | `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md` |

## Development

```bash
# one-time: fetch the basemap (~136 MB, not committed)
pmtiles extract https://build.protomaps.com/20260721.pmtiles data/london.pmtiles \
  --bbox=-0.55,51.25,0.35,51.72

cd frontend && npm install && npm run dev   # http://localhost:5173
```

## Delivery phases

P0 scaffold + dark basemap → P1 static transit lines → P2 real-time trains →
P3 all-London buses (WebSocket + deck.gl) → P4 aircraft/boats/JamCams →
P5 deploy (GitHub + Cloudflare Pages + Railway).
