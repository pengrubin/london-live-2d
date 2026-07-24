// Shared "Top N / total · X km today" leaderboard-rank line for vehicle
// popups. Fetches GET /api/leaderboard-rank; a 404 (vehicle unranked today)
// simply omits the line.

import type { Popup } from 'maplibre-gl';

export type RankMode = 'train' | 'bus' | 'ship';

interface RankInfo {
  rank: number;
  total: number;
  km: number;
}

export async function fetchRank(mode: RankMode, entryId: string): Promise<RankInfo | null> {
  try {
    const res = await fetch(
      `/api/leaderboard-rank?mode=${mode}&id=${encodeURIComponent(entryId)}`,
    );
    if (!res.ok) return null; // 404 → not ranked today
    const body = (await res.json()) as Partial<RankInfo>;
    if (
      typeof body.rank !== 'number' ||
      typeof body.total !== 'number' ||
      typeof body.km !== 'number'
    ) {
      return null;
    }
    return { rank: body.rank, total: body.total, km: body.km };
  } catch {
    return null;
  }
}

export function rankLineText(info: RankInfo): string {
  return `Top ${info.rank} / ${info.total} · ${info.km.toFixed(1)} km today`;
}

/**
 * Fetch the rank for `entryId` and append the line to the given popup's
 * `.vp` content. The content element is tagged with the entry id before the
 * fetch so a popup re-opened for another vehicle never receives a stale line.
 */
export function appendRankLine(popup: Popup, mode: RankMode, entryId: string): void {
  const root = popup.getElement()?.querySelector<HTMLElement>('.vp');
  if (!root) return;
  root.dataset.rankFor = entryId;
  void fetchRank(mode, entryId).then((info) => {
    if (!info) return;
    const current = popup.getElement()?.querySelector<HTMLElement>('.vp');
    if (!current || !current.isConnected || current.dataset.rankFor !== entryId) return;
    const line = document.createElement('div');
    line.className = 'vp-dim';
    line.textContent = rankLineText(info);
    current.append(line);
  });
}
