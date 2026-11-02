/** Approved public cartography endpoint. This is separate from credentialed data ingestion. */
export const BASEMAP = Object.freeze({
  id: 'openfreemap-dark',
  origin: 'https://tiles.openfreemap.org',
  styleUrl: 'https://tiles.openfreemap.org/styles/dark',
  attribution:
    '<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
  transitAttribution: '<a href="https://www.mta.info/developers">MTA static GTFS</a>',
});

/** All style, tile, sprite, and font requests use the same reviewed public origin. */
export function mapResourceRequest(url: string): { url: string; credentials: 'same-origin' } {
  const parsed = new URL(url);
  if (
    parsed.origin !== BASEMAP.origin ||
    parsed.username ||
    parsed.password ||
    !/^\/(?:styles\/dark\/?|planet(?:\/.*)?|fonts\/.*|sprites\/.*|natural_earth\/.*)$/.test(
      parsed.pathname,
    )
  ) {
    throw new Error('Unapproved map resource');
  }
  return { url: parsed.href, credentials: 'same-origin' };
}
