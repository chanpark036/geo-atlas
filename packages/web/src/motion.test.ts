import { expect,it } from 'vitest';
import { MotionLayer } from './motion';
import type { Catalog,TrackedEntity } from '@geoatlas/adapter-core';
const catalog:Catalog={routes:[{id:'A',name:'Test',color:'#ffffff',coordinates:[[0,0],[1,0],[1,1]],stops:[]}]};
const entity=(index:number):TrackedEntity=>({id:'one',key:'test|a|a|one',adapterId:'test',inputId:'a',scope:'a',layer:'subway',longitude:catalog.routes[0]!.coordinates[index]![0],latitude:catalog.routes[0]!.coordinates[index]![1],observedAt:'2026-10-29T18:00:00Z',receivedAt:'2026-10-29T18:00:00Z',stale:false,missingSnapshots:0,properties:{route:'A',pathIndex:index}});
it('follows track geometry and holds indefinitely at the reported target',()=>{
  const motion=new MotionLayer(catalog);motion.sync([entity(0)],0);motion.sync([entity(2)],100);
  expect(motion.points(850)[0]?.point).toEqual([1,0]);expect(motion.points(1600)[0]?.point).toEqual([1,1]);expect(motion.points(999999)[0]?.point).toEqual([1,1]);
});
it('retargets from the displayed position instead of jumping or queueing old targets',()=>{
  const motion=new MotionLayer(catalog);motion.sync([entity(0)],0);motion.sync([entity(2)],100);
  const before=motion.points(850)[0]?.point;motion.sync([entity(0)],850);expect(motion.points(850)[0]?.point).toEqual(before);expect(motion.points(2350)[0]?.point).toEqual([0,0]);
});
it('reconnect snapshots and reduced-motion settings place markers immediately',()=>{
  const motion=new MotionLayer(catalog);motion.sync([entity(0)],0);motion.sync([entity(2)],100,true);expect(motion.points(100)[0]?.point).toEqual([1,1]);
  const reduced=new MotionLayer(catalog,true);reduced.sync([entity(0)],0);reduced.sync([entity(2)],100);expect(reduced.points(100)[0]?.point).toEqual([1,1]);
});
it('does not restart an animation for a freshness-only update and removes vanished entities',()=>{
  const motion=new MotionLayer(catalog);motion.sync([entity(0)],0);motion.sync([entity(2)],100);motion.sync([{...entity(2),stale:true}],850);
  expect(motion.points(1600)[0]?.point).toEqual([1,1]);motion.sync([],1600);expect(motion.points(1600)).toEqual([]);
});

it('moves by distance rather than vertex count on unevenly sampled paths', () => {
  const dense: Catalog = { routes: [{ id: 'A', name: 'Test', color: '#ffffff', coordinates: [[0,0],[.1,0],[.2,0],[10,0]], stops: [] }] };
  const start = { ...entity(0), longitude: 0, latitude: 0 };
  const end = { ...entity(0), longitude: 10, latitude: 0, properties: { route: 'A', pathIndex: 3 } };
  const motion = new MotionLayer(dense);
  motion.sync([start], 0); motion.sync([end], 100);
  expect(motion.points(850)[0]?.point[0]).toBeCloseTo(5);
  expect(motion.points(1600)[0]?.point).toEqual([10,0]);
});
it('does not jump to a route vertex when persisted coordinates belong to an older geometry', () => {
  const old = { ...entity(0), longitude: -5, latitude: -5 };
  const motion = new MotionLayer(catalog);
  motion.sync([old], 0); motion.sync([entity(2)], 100);
  expect(motion.points(100)[0]?.point).toEqual([-5,-5]);
  expect(motion.points(1600)[0]?.point).toEqual([1,1]);
});
it('resumes route-following after a transition from older geometry reaches a valid stop', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([{ ...entity(0), longitude: -5, latitude: -5 }], 0);
  motion.sync([entity(0)], 100);
  motion.sync([entity(2)], 1700);
  expect(motion.points(2450)[0]?.point).toEqual([1,0]);
});
it('transitions vessel reports without a route and holds at the target', () => {
  const start = { ...entity(0), longitude: -74.02, latitude: 40.70, properties: { kind: 'vessel' } };
  const end = { ...start, longitude: -74.00, latitude: 40.72 };
  const motion = new MotionLayer(catalog);
  motion.sync([start], 0); motion.sync([end], 100);
  expect(motion.points(100)[0]?.point).toEqual([-74.02,40.70]);
  expect(motion.points(850)[0]?.point[0]).toBeCloseTo(-74.01);
  expect(motion.points(850)[0]?.point[1]).toBeCloseTo(40.71);
  expect(motion.points(9999)[0]?.point).toEqual([-74.00,40.72]);
});
