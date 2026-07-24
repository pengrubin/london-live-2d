/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute URL of the pmtiles basemap (e.g. an R2 public bucket URL).
   * Unset in local dev — the map falls back to /london.pmtiles served from
   * Vite's publicDir (data/).
   */
  readonly VITE_PMTILES_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
