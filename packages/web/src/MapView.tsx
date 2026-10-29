import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapType } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
import { MotionLayer } from './motion';
import { land, streetGrid } from './geography';

interface Props { catalog: Catalog; entities: TrackedEntity[]; resetToken: number; selected: string | null; onSelect: (key: string) => void; focusToken: number }
export function MapView({ catalog, entities, resetToken, selected, onSelect, focusToken }: Props) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapType | null>(null);
  const [error, setError] = useState(false), [ready, setReady] = useState(false);
  const motion = useRef(new MotionLayer(catalog, matchMedia('(prefers-reduced-motion: reduce)').matches));
  const current = useRef({ entities, selected, onSelect }); current.current = { entities, selected, onSelect };
  const dirty = useRef(true), lastReset = useRef(resetToken);
  useEffect(() => {
    if (!container.current) return;
    let instance: MapType;
    try {
      instance = new maplibregl.Map({ container: container.current, center: [-74.000,40.736], zoom: 12.6, minZoom: 10, maxZoom: 16,
        attributionControl: false, style: { version: 8, sources: {}, layers: [{ id:'water',type:'background',paint:{'background-color':'#0b1c28'} }] } });
    } catch { setError(true); return; }
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    instance.on('error', () => setError(true));
    instance.on('load', () => {
      instance.addSource('land', { type:'geojson',data:land });
      instance.addLayer({ id:'land',type:'fill',source:'land',paint:{'fill-color':'#172c36','fill-outline-color':'#29414b'} });
      instance.addSource('streets', { type:'geojson',data:streetGrid });
      instance.addLayer({ id:'streets',type:'line',source:'streets',paint:{'line-color':'#29404a','line-width':1,'line-opacity':.6} });
      instance.addSource('routes',{type:'geojson',data:{type:'FeatureCollection',features:catalog.routes.map(r=>({type:'Feature',properties:{color:r.color},geometry:{type:'LineString',coordinates:r.coordinates}}))}});
      instance.addLayer({id:'route-glow',type:'line',source:'routes',paint:{'line-color':['get','color'],'line-width':9,'line-opacity':.08}});
      instance.addLayer({id:'routes',type:'line',source:'routes',paint:{'line-color':['get','color'],'line-width':2,'line-opacity':.6}});
      for (const stop of catalog.routes[0]?.stops ?? []) {
        const coordinates = catalog.routes[0]!.coordinates[stop.pathIndex]!;
        const element = document.createElement('div'); element.className = 'station-label';
        const dot = document.createElement('i'), label = document.createElement('span'); label.textContent = stop.name;
        element.append(dot,label); new maplibregl.Marker({element,anchor:'left',offset:[-3,0]}).setLngLat(coordinates).addTo(instance);
      }
      instance.addSource('entities',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      instance.addLayer({id:'entity-halo',type:'circle',source:'entities',paint:{'circle-radius':['case',['get','selected'],18,12],'circle-color':['get','color'],'circle-opacity':.12}});
      instance.addLayer({id:'entities',type:'circle',source:'entities',paint:{'circle-radius':['case',['get','selected'],8,6],'circle-color':['get','color'],'circle-stroke-color':'#e3f1f4','circle-stroke-width':1.5,'circle-opacity':['case',['get','stale'],.35,1]}});
      instance.on('click','entities',event=> { const key=event.features?.[0]?.properties?.key as unknown; if(typeof key==='string')current.current.onSelect(key); });
      instance.on('mouseenter','entities',()=> {instance.getCanvas().style.cursor='pointer';});
      instance.on('mouseleave','entities',()=> {instance.getCanvas().style.cursor='';});
      dirty.current=true; setReady(true);
    });
    let frame=0;
    const animate = (now:number) => {
      if (instance.getSource('entities') && (dirty.current || motion.current.moving(now))) {
        const data:FeatureCollection<Point> = {type:'FeatureCollection',features:motion.current.points(now).map(({entity,point})=>({type:'Feature',geometry:{type:'Point',coordinates:point},properties:{key:entity.key,stale:entity.stale,selected:entity.key===current.current.selected,color:catalog.routes.find(r=>r.id===entity.properties.route)?.color??'#efbc79'}}))};
        (instance.getSource('entities') as GeoJSONSource).setData(data); dirty.current=motion.current.moving(now);
      }
      frame=requestAnimationFrame(animate);
    };
    frame=requestAnimationFrame(animate);
    return()=> {cancelAnimationFrame(frame);instance.remove();map.current=null;};
  },[catalog]);
  useEffect(()=> {
    motion.current.sync(entities,performance.now(),lastReset.current!==resetToken);lastReset.current=resetToken;dirty.current=true;
  },[entities,resetToken]);
  useEffect(()=>{dirty.current=true;},[selected]);
  useEffect(()=> {
    const entity=current.current.entities.find(e=>e.key===current.current.selected);
    if(focusToken && entity)map.current?.easeTo({center:[entity.longitude,entity.latitude],zoom:14,duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:700});
  },[focusToken]);
  return <div className="map-shell"><div className="map-canvas" ref={container}/>{!ready&&!error&&<div className="map-message">Preparing the observatory…</div>}{error&&<div className="map-message" role="alert">Map unavailable. You can still inspect reports in the entity list.</div>}<div className="map-place">NEW YORK HARBOR<span>40.73° N / 74.00° W</span></div><div className="water-label">HUDSON RIVER</div><div className="map-disclaimer">Synthetic reports · Schematic geography · Not for navigation</div></div>;
}
