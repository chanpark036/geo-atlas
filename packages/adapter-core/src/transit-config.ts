/** Route ownership verified against MTA's public feed directory on 2026-11-01. */
export const MTA_FEEDS = [
  {
    id: 'numbered',
    label: '1–7 / 42 St Shuttle',
    suffix: 'gtfs',
    routes: ['1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'GS'],
  },
  {
    id: 'ace',
    label: 'A / C / E / Rockaway Shuttle',
    suffix: 'gtfs-ace',
    routes: ['A', 'C', 'E', 'H'],
  },
  {
    id: 'bdfm',
    label: 'B / D / F / M / Franklin Shuttle',
    suffix: 'gtfs-bdfm',
    routes: ['B', 'D', 'F', 'FX', 'M', 'FS'],
  },
  { id: 'g', label: 'G', suffix: 'gtfs-g', routes: ['G'] },
  { id: 'jz', label: 'J / Z', suffix: 'gtfs-jz', routes: ['J', 'Z'] },
  { id: 'l', label: 'L', suffix: 'gtfs-l', routes: ['L'] },
  { id: 'nqrw', label: 'N / Q / R / W', suffix: 'gtfs-nqrw', routes: ['N', 'Q', 'R', 'W'] },
  { id: 'si', label: 'Staten Island Railway', suffix: 'gtfs-si', routes: ['SI'] },
] as const;
export const MTA_ROUTE_IDS: readonly string[] = MTA_FEEDS.flatMap((feed) => [...feed.routes]);
