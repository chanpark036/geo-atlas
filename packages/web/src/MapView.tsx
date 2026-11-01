import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapType, type StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { BASEMAP, mapResourceRequest, type Catalog, type TrackedEntity } from '@geoatlas/adapter-core';
import { MotionLayer } from './motion';

interface Props {
  catalog: Catalog;
  entities: TrackedEntity[];
  resetToken: number;
  selected: string | null;
  onSelect: (key: string) => void;
  focusToken: number;
}
type BasemapStatus = 'loading' | 'ready' | 'unavailable' | 'partial';
const routeOnlyStyle = (): StyleSpecification => ({
  version: 8, sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1c28' } }],
});

export function MapView({ catalog, entities, resetToken, selected, onSelect, focusToken }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapType | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapStatus>('loading');
  const retryBasemap = useRef<() => void>(() => {});
  const motion = useRef(new MotionLayer(catalog, matchMedia('(prefers-reduced-motion: reduce)').matches));
  const current = useRef({ entities, selected, onSelect });
  current.current = { entities, selected, onSelect };
  const dirty = useRef(true);
  const lastReset = useRef(resetToken);

  useEffect(() => {
    if (!container.current) return;
    let instance: MapType;
    try {
      instance = new maplibregl.Map({
        container: container.current, center: [-73.998, 40.739], zoom: 12.6, minZoom: 10, maxZoom: 17,
        attributionControl: { compact: false, customAttribution: BASEMAP.transitAttribution },
        transformRequest: mapResourceRequest,
        style: BASEMAP.styleUrl,
      });
    } catch { setError(true); return; }
    map.current = instance;
    let disposed = false;
    let mode: 'remote' | 'fallback' = 'remote';
    let styleInstalled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const markers: maplibregl.Marker[] = [];
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const fallback = () => {
      if (disposed || mode === 'fallback') return;
      mode = 'fallback';
      clearTimeout(timeout);
      setBasemap('unavailable');
      // Retain geographic route/stop positions; never disguise a schematic as a real basemap.
      instance.setStyle(routeOnlyStyle(), { diff: false });
    };
    const armTimeout = () => { timeout = setTimeout(fallback, 10_000); };
    armTimeout();
    retryBasemap.current = () => {
      if (disposed) return;
      mode = 'remote'; styleInstalled = false;
      setBasemap('loading'); clearTimeout(timeout); armTimeout();
      instance.setStyle(BASEMAP.styleUrl, { diff: false });
    };
    instance.on('error', () => {
      if (disposed) return;
      if (mode === 'remote' && !styleInstalled) fallback();
      else if (mode === 'remote') setBasemap('partial');
    });
    instance.on('style.load', () => {
      if (disposed) return;
      styleInstalled = true;
      clearTimeout(timeout);
      if (mode === 'remote') setBasemap('ready');
      for (const marker of markers.splice(0)) marker.remove();
      instance.addSource('routes', {
        type: 'geojson', data: {
          type: 'FeatureCollection', features: catalog.routes.map(route => ({
            type: 'Feature', properties: { color: route.color, route: route.id },
            geometry: { type: 'LineString', coordinates: route.coordinates },
          })),
        },
      });
      instance.addLayer({ id: 'route-glow', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 10, 'line-opacity': .12 } });
      instance.addLayer({
        id: 'routes', type: 'line', source: 'routes',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': .8, 'line-offset': ['match', ['get', 'route'], 'C', 2.5, 'E', -2.5, 0] },
      });
      const seen = new Set<string>();
      for (const route of catalog.routes) for (const stop of route.stops) {
        const coordinates = route.coordinates[stop.pathIndex]!;
        const identity = coordinates.join(',');
        if (seen.has(identity)) continue;
        seen.add(identity);
        const element = document.createElement('div');
        element.className = 'station-label';
        const dot = document.createElement('i');
        const label = document.createElement('span');
        label.textContent = stop.name;
        element.append(dot, label);
        markers.push(new maplibregl.Marker({ element, anchor: 'left', offset: [-3, 0] }).setLngLat(coordinates).addTo(instance));
      }
      instance.addSource('entities', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      instance.addLayer({ id: 'entity-halo', type: 'circle', source: 'entities', paint: { 'circle-radius': ['case', ['get', 'selected'], 18, 12], 'circle-color': ['get', 'color'], 'circle-opacity': .15 } });
      instance.addLayer({ id: 'entities', type: 'circle', source: 'entities', paint: { 'circle-radius': ['case', ['get', 'selected'], 8, 6], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#e3f1f4', 'circle-stroke-width': 1.5, 'circle-opacity': ['case', ['get', 'stale'], .35, 1] } });
      dirty.current = true;
      setReady(true);
    });
    instance.on('click', event => {
      if (!instance.getLayer('entities')) return;
      const key: unknown = instance.queryRenderedFeatures(event.point, { layers: ['entities'] })[0]?.properties?.key;
      if (typeof key === 'string') current.current.onSelect(key);
    });
    instance.on('mousemove', event => {
      const hit = instance.getLayer('entities') && instance.queryRenderedFeatures(event.point, { layers: ['entities'] }).length;
      instance.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
    let frame = 0;
    const animate = (now: number) => {
      if (instance.getSource('entities') && (dirty.current || motion.current.moving(now))) {
        const data: FeatureCollection<Point> = {
          type: 'FeatureCollection', features: motion.current.points(now).map(({ entity, point }) => ({
            type: 'Feature', geometry: { type: 'Point', coordinates: point },
            properties: { key: entity.key, stale: entity.stale, selected: entity.key === current.current.selected, color: catalog.routes.find(route => route.id === entity.properties.route)?.color ?? '#efbc79' },
          })),
        };
        (instance.getSource('entities') as GeoJSONSource).setData(data);
        dirty.current = motion.current.moving(now);
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      disposed = true; clearTimeout(timeout); cancelAnimationFrame(frame);
      for (const marker of markers) marker.remove();
      instance.remove(); map.current = null;
    };
  }, [catalog]);
  useEffect(() => {
    motion.current.sync(entities, performance.now(), lastReset.current !== resetToken);
    lastReset.current = resetToken; dirty.current = true;
  }, [entities, resetToken]);
  useEffect(() => { dirty.current = true; }, [selected]);
  useEffect(() => {
    const entity = current.current.entities.find(item => item.key === current.current.selected);
    if (focusToken && entity) map.current?.easeTo({ center: [entity.longitude, entity.latitude], zoom: 14, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700 });
  }, [focusToken]);
  return <div className="map-shell">
    <div className="map-canvas" ref={container} />
    {!ready && !error && <div className="map-message">Preparing the New York map…</div>}
    {error && <div className="map-message" role="alert">Map unavailable. You can still inspect reports in the entity list.</div>}
    {!error && (basemap === 'unavailable' || basemap === 'partial') && <div className="basemap-warning" role="status">
      <span>{basemap === 'unavailable' ? 'Background map unavailable. Showing geographic routes and stops only.' : 'Some background map tiles could not load.'}</span>
      <button onClick={() => retryBasemap.current()}>Retry map</button>
    </div>}
    <div className="map-place">NEW YORK HARBOR<span>40.73° N / 74.00° W</span></div>
    <div className="map-disclaimer">Synthetic traffic · MTA static route geometry · Not for navigation</div>
  </div>;
}
