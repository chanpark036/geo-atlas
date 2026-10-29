import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
export type Point = [number, number];
type Motion = { entity: TrackedEntity; from: Point; to: Point; route: Catalog['routes'][number] | undefined; fromIndex: number | undefined; toIndex: number | undefined; started: number; duration: number };
const ease = (t: number) => t * t * (3 - 2 * t);
export function pointAlong(coordinates: Point[], index: number): Point {
  const clamped = Math.min(coordinates.length - 1, Math.max(0, index));
  const first = Math.floor(clamped), a = coordinates[first]!, b = coordinates[Math.min(first + 1, coordinates.length - 1)]!;
  const t = clamped - first;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** Display-only transitions. Never extrapolates beyond a reported target. */
export class MotionLayer {
  private records = new Map<string, Motion>();
  constructor(private readonly catalog: Catalog, private readonly reducedMotion = false) {}
  sync(entities: readonly TrackedEntity[], now: number, reset = false): void {
    const keys = new Set(entities.map(e => e.key));
    for (const key of this.records.keys()) if (!keys.has(key)) this.records.delete(key);
    for (const entity of entities) {
      const previous = this.records.get(entity.key);
      if (!reset && previous && previous.entity.longitude === entity.longitude && previous.entity.latitude === entity.latitude) { previous.entity = entity; continue; }
      const route = this.catalog.routes.find(r => r.id === entity.properties.route);
      const toIndex = typeof entity.properties.pathIndex === 'number' && route && Number.isInteger(entity.properties.pathIndex) && entity.properties.pathIndex >= 0 && entity.properties.pathIndex < route.coordinates.length ? entity.properties.pathIndex : undefined;
      const sampled = previous ? this.sampleMotion(previous, now) : undefined;
      const canFollow = previous?.route?.id === route?.id && previous?.toIndex !== undefined && toIndex !== undefined;
      const direct = reset || !previous || this.reducedMotion;
      this.records.set(entity.key, { entity, from: direct ? [entity.longitude,entity.latitude] : sampled!.point,
        to: [entity.longitude,entity.latitude], route: canFollow || direct ? route : undefined, fromIndex: canFollow ? sampled!.index : toIndex, toIndex,
        started: now, duration: direct ? 0 : 1_500 });
    }
  }
  points(now: number): { entity: TrackedEntity; point: Point }[] {
    return [...this.records.values()].map(motion => ({ entity: motion.entity, point: this.sampleMotion(motion, now).point }));
  }
  moving(now: number): boolean { return [...this.records.values()].some(m => now - m.started < m.duration); }
  private sampleMotion(motion: Motion, now: number): { point: Point; index: number | undefined } {
    const t = motion.duration ? ease(Math.max(0, Math.min(1, (now - motion.started) / motion.duration))) : 1;
    if (motion.route && motion.fromIndex !== undefined && motion.toIndex !== undefined) {
      const index = motion.fromIndex + (motion.toIndex - motion.fromIndex) * t;
      return { point: t === 1 ? motion.to : pointAlong(motion.route.coordinates, index), index };
    }
    return { point: [motion.from[0] + (motion.to[0] - motion.from[0]) * t, motion.from[1] + (motion.to[1] - motion.from[1]) * t], index: undefined };
  }
}
