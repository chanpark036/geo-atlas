import type { FeatureCollection, Polygon, LineString } from 'geojson';
// Hand-drawn context for the synthetic demo; not navigational geography.
const polygon = (coordinates: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } });
export const land: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [
  polygon([[-74.019,40.701],[-74.010,40.702],[-73.997,40.713],[-73.982,40.730],[-73.975,40.741],[-73.966,40.754],[-73.956,40.769],[-73.947,40.791],[-73.958,40.800],[-73.974,40.781],[-73.986,40.770],[-73.997,40.750],[-74.010,40.725],[-74.019,40.701]]),
  polygon([[-74.15,40.66],[-74.04,40.66],[-74.031,40.70],[-74.033,40.73],[-74.022,40.76],[-74.001,40.80],[-74.15,40.80],[-74.15,40.66]]),
  polygon([[-74.010,40.66],[-73.90,40.66],[-73.90,40.80],[-73.936,40.80],[-73.944,40.77],[-73.953,40.75],[-73.967,40.736],[-73.967,40.72],[-73.983,40.705],[-74.006,40.695],[-74.010,40.66]]),
] };
const streets: FeatureCollection<LineString>['features'] = [];
for (let i = 0; i < 22; i++) {
  const y = 40.716 + i * .0029, x = -74.006 + i * .00125;
  streets.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x,y],[x+.020,y+.007]] } });
}
for (let i=0; i<7; i++) streets.push({ type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates:[[-74.009+i*.003,40.716+i*.001],[-73.982+i*.003,40.779+i*.001]] } });
export const streetGrid: FeatureCollection<LineString> = { type: 'FeatureCollection', features: streets };
