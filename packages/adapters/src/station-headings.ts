import { z } from 'zod';
import artifact from './data/subway-headings.json' with { type: 'json' };

const bearingSchema = z.number().finite().min(0).lt(360);
const stationId = z.string().regex(/^[A-Z0-9]{2,8}$/);
const stopId = z.string().regex(/^[A-Z0-9]{2,8}[NS]$/);
const headingArtifactSchema = z
  .strictObject({
    source: z.strictObject({
      url: z.literal('https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip'),
      retrievedAt: z.iso.date(),
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
      feedVersion: z.string().min(1).max(128),
    }),
    stations: z
      .array(
        z.tuple([
          stationId,
          z.number().finite().min(-180).max(180),
          z.number().finite().min(-90).max(90),
        ]),
      )
      .max(1000),
    patterns: z
      .array(
        z.strictObject({
          routeId: z.string().regex(/^[A-Z0-9]{1,8}$/),
          shapeId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-zA-Z0-9_.:/-]+$/),
          headings: z
            .array(z.tuple([stopId, bearingSchema.nullable()]))
            .min(1)
            .max(100),
        }),
      )
      .max(512),
  })
  .superRefine((data, context) => {
    const stations = new Set(data.stations.map(([id]) => id));
    const patterns = new Set(
      data.patterns.map((pattern) => `${pattern.routeId}|${pattern.shapeId}`),
    );
    if (stations.size !== data.stations.length || patterns.size !== data.patterns.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate heading identity' });
    }
    for (const pattern of data.patterns) {
      if (
        new Set(pattern.headings.map(([id]) => id)).size !== pattern.headings.length ||
        pattern.headings.some(([id]) => !stations.has(id.slice(0, -1)))
      ) {
        context.addIssue({ code: 'custom', message: 'Invalid heading station relationship' });
      }
    }
  });

function consistentBearing(variants: readonly (number | null)[]): number | null {
  // A missing realtime shape ID may use a station heading only when every
  // published variant agrees locally. Circular distance handles 359° versus 1°.
  if (variants.some((angle) => angle === null)) return null;
  const angles = variants.filter((angle) => angle !== null);
  if (angles.some((a) => angles.some((b) => Math.abs(((a - b + 540) % 360) - 180) > 20))) {
    return null;
  }
  const east = angles.reduce((sum, angle) => sum + Math.sin((angle * Math.PI) / 180), 0);
  const north = angles.reduce((sum, angle) => sum + Math.cos((angle * Math.PI) / 180), 0);
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/** Static station orientation is separate from permission to animate an entire trip path. */
export class StationHeadings {
  private readonly fingerprint: string;
  private readonly stations: Map<string, [number, number]>;
  private readonly patterns = new Map<string, Map<string, number | null>>();
  private readonly fallback = new Map<string, number | null>();

  constructor(input: unknown) {
    const data = headingArtifactSchema.parse(input);
    this.fingerprint = data.source.archiveSha256;
    this.stations = new Map(
      data.stations.map(([id, longitude, latitude]) => [id, [longitude, latitude]]),
    );
    const variants = new Map<string, (number | null)[]>();
    for (const pattern of data.patterns) {
      this.patterns.set(`${pattern.routeId}|${pattern.shapeId}`, new Map(pattern.headings));
      for (const [stop, angle] of pattern.headings) {
        const key = `${pattern.routeId}|${stop}`;
        const angles = variants.get(key) ?? [];
        angles.push(angle);
        variants.set(key, angles);
      }
    }
    for (const [key, angles] of variants) this.fallback.set(key, consistentBearing(angles));
  }

  get(
    fingerprint: string | undefined,
    route: string,
    shape: string,
    stop: string,
    longitude: number,
    latitude: number,
  ): number | null {
    if (
      fingerprint !== this.fingerprint ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    )
      return null;
    const station = this.stations.get(stop.slice(0, -1));
    if (
      !station ||
      Math.abs(station[0] - longitude) > 1e-8 ||
      Math.abs(station[1] - latitude) > 1e-8
    ) {
      return null;
    }
    const pattern = this.patterns.get(`${route}|${shape}`);
    // A known shape that does not contain this station cannot justify a heading.
    if (pattern) return pattern.get(stop) ?? null;
    return this.fallback.get(`${route}|${stop}`) ?? null;
  }
}

export const subwayStationHeadings = new StationHeadings(artifact);
