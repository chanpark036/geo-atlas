import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
  type GeoJSONSource,
  type ExpressionSpecification,
  type Map as MapType,
  type StyleSpecification,
} from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import {
  BASEMAP,
  mapResourceRequest,
  type Catalog,
  type TrackedEntity,
} from '@geoatlas/adapter-core';
import { MotionLayer } from './motion';
import { entityColor, networkBounds, routeFeatures, stationFeatures } from './layers';
import { addTrainDirectionImage } from './train-direction';

interface Props {
  catalog: Catalog;
  entities: TrackedEntity[];
  resetToken: number;
  selected: string | null;
  onSelect: (key: string) => void;
  focusToken: number;
  fitToken: number;
  visibleRoutes: readonly string[];
}
type BasemapStatus = 'loading' | 'ready' | 'unavailable' | 'partial';
const entityOpacity: ExpressionSpecification = [
  '*',
  ['get', 'opacity'],
  ['case', ['get', 'stale'], 0.35, 1],
];
const routeOnlyStyle = (): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1c28' } }],
});

export function MapView({
  catalog,
  entities,
  resetToken,
  selected,
  onSelect,
  focusToken,
  fitToken,
  visibleRoutes,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapType | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapStatus>('loading');
  const retryBasemap = useRef<() => void>(() => {});
  const motion = useMemo(
    () => new MotionLayer(catalog, matchMedia('(prefers-reduced-motion: reduce)').matches),
    [catalog],
  );
  const current = useRef({ entities, selected, onSelect, visibleRoutes });
  current.current = { entities, selected, onSelect, visibleRoutes };
  const fitNetwork = useRef<() => void>(() => {});
  const refreshSelection = useRef<() => void>(() => {});
  const dirty = useRef(true);
  const lastReset = useRef(resetToken);

  useEffect(() => {
    if (!container.current) return;
    let instance: MapType;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        center: [-73.998, 40.739],
        zoom: 12.6,
        minZoom: 8,
        maxZoom: 17,
        attributionControl: { compact: false, customAttribution: BASEMAP.transitAttribution },
        transformRequest: mapResourceRequest,
        style: BASEMAP.styleUrl,
      });
    } catch {
      setError(true);
      return;
    }
    map.current = instance;
    let disposed = false;
    let mode: 'remote' | 'fallback' = 'remote';
    let styleInstalled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const labelElement = document.createElement('div');
    labelElement.className = 'station-label';
    const labelText = document.createElement('span');
    labelElement.append(labelText);
    const selectedStation = new maplibregl.Marker({
      element: labelElement,
      anchor: 'left',
      offset: [12, 0],
    });
    refreshSelection.current = () => {
      const entity = current.current.entities.find((item) => item.key === current.current.selected);
      if (!entity || entity.layer !== 'subway') {
        selectedStation.remove();
        return;
      }
      labelText.textContent = String(entity.properties.stop ?? 'Reported stop');
      selectedStation.setLngLat([entity.longitude, entity.latitude]).addTo(instance);
    };
    fitNetwork.current = () =>
      instance.fitBounds(networkBounds(catalog), {
        padding: 35,
        maxZoom: 12.6,
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600,
      });
    if (catalog.stations)
      instance.fitBounds(networkBounds(catalog), { padding: 35, maxZoom: 12.6, duration: 0 });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const fallback = () => {
      if (disposed || mode === 'fallback') return;
      mode = 'fallback';
      clearTimeout(timeout);
      setBasemap('unavailable');
      // Retain geographic route/stop positions; never disguise a schematic as a real basemap.
      instance.setStyle(routeOnlyStyle(), { diff: false });
    };
    const armTimeout = () => {
      timeout = setTimeout(fallback, 10_000);
    };
    armTimeout();
    retryBasemap.current = () => {
      if (disposed) return;
      mode = 'remote';
      styleInstalled = false;
      setBasemap('loading');
      clearTimeout(timeout);
      armTimeout();
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
      instance.addSource('routes', {
        type: 'geojson',
        data: routeFeatures(catalog, current.current.visibleRoutes),
      });
      instance.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'routes',
        paint: { 'line-color': ['get', 'color'], 'line-width': 10, 'line-opacity': 0.12 },
      });
      instance.addLayer({
        id: 'routes',
        type: 'line',
        source: 'routes',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.8,
          'line-offset': ['get', 'offset'],
        },
      });
      instance.addSource('stations', {
        type: 'geojson',
        data: stationFeatures(catalog, current.current.visibleRoutes),
      });
      instance.addLayer({
        id: 'stations',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.4, 14, 3],
          'circle-color': '#203c48',
          'circle-stroke-color': '#b0c6d0',
          'circle-stroke-width': 0.8,
        },
      });
      refreshSelection.current();
      instance.addSource('entities', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      instance.addLayer({
        id: 'entity-halo',
        type: 'circle',
        source: 'entities',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 18, 12],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['*', 0.15, ['get', 'opacity']],
        },
      });
      instance.addLayer({
        id: 'entities',
        type: 'circle',
        source: 'entities',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'layer'], 'subway'],
            ['case', ['get', 'selected'], 10, 8],
            ['case', ['get', 'selected'], 8, 6],
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#e3f1f4',
          'circle-stroke-width': 1.5,
          'circle-opacity': entityOpacity,
          'circle-stroke-opacity': entityOpacity,
        },
      });
      addTrainDirectionImage(instance);
      instance.addLayer({
        id: 'train-directions',
        type: 'symbol',
        source: 'entities',
        filter: ['all', ['==', ['get', 'layer'], 'subway'], ['!=', ['get', 'bearing'], null]],
        layout: {
          'icon-image': 'train-arrowhead',
          'icon-rotate': ['get', 'bearing'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'viewport',
        },
        paint: { 'icon-opacity': entityOpacity },
      });
      dirty.current = true;
      setReady(true);
    });
    instance.on('click', (event) => {
      if (!instance.getLayer('entities')) return;
      const key: unknown = instance.queryRenderedFeatures(event.point, { layers: ['entities'] })[0]
        ?.properties?.key;
      if (typeof key === 'string') current.current.onSelect(key);
    });
    instance.on('mousemove', (event) => {
      const hit =
        instance.getLayer('entities') &&
        instance.queryRenderedFeatures(event.point, { layers: ['entities'] }).length;
      instance.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
    let frame = 0;
    const animate = (now: number) => {
      if (instance.getSource('entities') && (dirty.current || motion.moving(now))) {
        const data: FeatureCollection<Point> = {
          type: 'FeatureCollection',
          features: motion.points(now).map(({ entity, point, opacity, bearing }) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: point },
            properties: {
              key: entity.key,
              layer: entity.layer,
              bearing,
              opacity,
              stale: entity.stale,
              selected: entity.key === current.current.selected,
              color: entityColor(entity, catalog),
            },
          })),
        };
        (instance.getSource('entities') as GeoJSONSource).setData(data);
        dirty.current = motion.moving(now);
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      disposed = true;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      selectedStation.remove();
      instance.remove();
      map.current = null;
    };
  }, [catalog, motion]);
  useEffect(() => {
    motion.sync(entities, performance.now(), lastReset.current !== resetToken);
    lastReset.current = resetToken;
    dirty.current = true;
    refreshSelection.current();
  }, [entities, resetToken, motion]);
  useEffect(() => {
    dirty.current = true;
    refreshSelection.current();
  }, [selected]);
  useEffect(() => {
    if (fitToken) fitNetwork.current();
  }, [fitToken]);
  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource('routes') as GeoJSONSource | undefined)?.setData(
      routeFeatures(catalog, visibleRoutes),
    );
    (map.current.getSource('stations') as GeoJSONSource | undefined)?.setData(
      stationFeatures(catalog, visibleRoutes),
    );
  }, [catalog, visibleRoutes, ready]);
  useEffect(() => {
    const entity = current.current.entities.find((item) => item.key === current.current.selected);
    if (focusToken && entity)
      map.current?.easeTo({
        center: [entity.longitude, entity.latitude],
        zoom: 14,
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700,
      });
  }, [focusToken]);
  return (
    <div className="map-shell">
      <div className="map-canvas" ref={container} />
      {!ready && !error && <div className="map-message">Preparing the New York map…</div>}
      {error && (
        <div className="map-message" role="alert">
          Map unavailable. You can still inspect reports in the entity list.
        </div>
      )}
      {!error && (basemap === 'unavailable' || basemap === 'partial') && (
        <div className="basemap-warning" role="status">
          <span>
            {basemap === 'unavailable'
              ? 'Background map unavailable. Showing geographic routes and stops only.'
              : 'Some background map tiles could not load.'}
          </span>
          <button onClick={() => retryBasemap.current()}>Retry map</button>
        </div>
      )}
      <div className="map-place">
        NEW YORK CITY<span>40.73° N / 74.00° W</span>
      </div>
      <div className="map-disclaimer">
        Stop associations · MTA static geometry · Not for navigation
      </div>
    </div>
  );
}
