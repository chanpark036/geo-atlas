import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
export type Point = [number, number];
type Route = Catalog['routes'][number];
type Path = { route: Route; distances: number[] };
type Motion = {
  entity: TrackedEntity;
  from: Point;
  to: Point;
  path: Path | undefined;
  targetPath: Path | undefined;
  fromDistance: number | undefined;
  toDistance: number | undefined;
  started: number;
  duration: number;
  fade: boolean;
  fromOpacity: number;
};
const ease = (t: number) => t * t * (3 - 2 * t);
export function pointAlong(coordinates: Point[], index: number): Point {
  const clamped = Math.min(coordinates.length - 1, Math.max(0, index));
  const first = Math.floor(clamped),
    a = coordinates[first]!,
    b = coordinates[Math.min(first + 1, coordinates.length - 1)]!;
  const t = clamped - first;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function distancesAlong(coordinates: Point[]): number[] {
  const distances = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!,
      b = coordinates[i]!;
    const longitudeScale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    // Local equirectangular distance is sufficient for a Manhattan display transition.
    distances.push(distances[i - 1]! + Math.hypot((b[0] - a[0]) * longitudeScale, b[1] - a[1]));
  }
  return distances;
}
function pointAtDistance(path: Path, distance: number): Point {
  const { distances, route } = path;
  if (distance <= 0) return route.coordinates[0]!;
  if (distance >= distances[distances.length - 1]!)
    return route.coordinates[route.coordinates.length - 1]!;
  let low = 0,
    high = distances.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid]! <= distance) low = mid;
    else high = mid;
  }
  const length = distances[high]! - distances[low]!;
  return pointAlong(route.coordinates, low + (length ? (distance - distances[low]!) / length : 0));
}
/** Display-only transitions. Never extrapolates beyond a reported target. */
export class MotionLayer {
  private records = new Map<string, Motion>();
  private readonly paths: Map<string, Path>;
  constructor(
    catalog: Catalog,
    private readonly reducedMotion = false,
  ) {
    this.paths = new Map(
      catalog.routes.map((route) => [
        route.id,
        { route, distances: distancesAlong(route.coordinates) },
      ]),
    );
  }
  sync(entities: readonly TrackedEntity[], now: number, reset = false): void {
    const keys = new Set(entities.map((entity) => entity.key));
    for (const key of this.records.keys()) if (!keys.has(key)) this.records.delete(key);
    for (const entity of entities) {
      const previous = this.records.get(entity.key);
      if (
        !reset &&
        previous &&
        previous.entity.longitude === entity.longitude &&
        previous.entity.latitude === entity.latitude
      ) {
        previous.entity = entity;
        continue;
      }
      const candidate =
        typeof entity.properties.route === 'string'
          ? this.paths.get(entity.properties.route)
          : undefined;
      const index = entity.properties.pathIndex;
      const vertex =
        candidate && typeof index === 'number' && Number.isInteger(index)
          ? candidate.route.coordinates[index]
          : undefined;
      // Old persisted demo geometry or a mismatched route index must not jump to another path.
      const path =
        vertex &&
        Math.abs(vertex[0] - entity.longitude) < 1e-8 &&
        Math.abs(vertex[1] - entity.latitude) < 1e-8
          ? candidate
          : undefined;
      const toDistance = path ? path.distances[index as number] : undefined;
      const sampled = previous ? this.sampleMotion(previous, now) : undefined;
      const samePath =
        previous &&
        (previous.path === path ||
          (previous.targetPath === path && now >= previous.started + previous.duration));
      const canFollow =
        path && samePath && sampled?.distance !== undefined && toDistance !== undefined;
      const direct = reset || !previous || this.reducedMotion;
      const fade =
        !direct &&
        (entity.properties.animation === 'fade' ||
          previous?.entity.properties.animation === 'fade' ||
          (entity.properties.source === 'mta' && !canFollow));
      this.records.set(entity.key, {
        entity,
        from: direct ? [entity.longitude, entity.latitude] : sampled!.point,
        to: [entity.longitude, entity.latitude],
        path: (canFollow || direct) && !fade ? path : undefined,
        targetPath: path,
        fromDistance: canFollow ? sampled.distance : toDistance,
        toDistance,
        started: now,
        duration: direct ? 0 : 1_500,
        fade,
        fromOpacity: sampled?.opacity ?? 1,
      });
    }
  }
  points(now: number): { entity: TrackedEntity; point: Point; opacity: number }[] {
    return [...this.records.values()].map((motion) => ({
      entity: motion.entity,
      point: this.sampleMotion(motion, now).point,
      opacity: this.sampleMotion(motion, now).opacity,
    }));
  }
  moving(now: number): boolean {
    return [...this.records.values()].some((motion) => now - motion.started < motion.duration);
  }
  private sampleMotion(
    motion: Motion,
    now: number,
  ): { point: Point; distance: number | undefined; opacity: number } {
    const progress = motion.duration
      ? Math.max(0, Math.min(1, (now - motion.started) / motion.duration))
      : 1;
    const t = ease(progress);
    if (motion.fade) {
      return {
        point: progress < 0.5 ? motion.from : motion.to,
        distance: progress === 1 ? motion.toDistance : undefined,
        opacity:
          progress < 0.5
            ? motion.fromOpacity * (1 - ease(progress * 2))
            : ease((progress - 0.5) * 2),
      };
    }
    if (motion.path && motion.fromDistance !== undefined && motion.toDistance !== undefined) {
      const distance = motion.fromDistance + (motion.toDistance - motion.fromDistance) * t;
      return {
        point: t === 1 ? motion.to : pointAtDistance(motion.path, distance),
        distance,
        opacity: 1,
      };
    }
    return {
      point: [
        motion.from[0] + (motion.to[0] - motion.from[0]) * t,
        motion.from[1] + (motion.to[1] - motion.from[1]) * t,
      ],
      distance: t === 1 ? motion.toDistance : undefined,
      opacity: 1,
    };
  }
}
