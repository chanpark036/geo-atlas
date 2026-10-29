import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { StateManager, entityKey } from './state.ts';
import { LIMITS, manifestSchema, type AdapterManifest, type GeoEntity, type AdapterBatch, type SourcePacket, type DataAdapter } from './schema.ts';
const now = Date.parse('2026-10-29T18:00:00Z');
const iso = (offset=0)=>new Date(now+offset).toISOString();
const manifest: AdapterManifest = { id:'test',layer:'subway',attribution:'Fixture',license:{name:'Test'},staleAfterMs:10_000,expireAfterMs:30_000,snapshotGrace:2,
  inputs:[{id:'a',scope:'a',endpointId:'a',kind:'poll',intervalMs:1000,semantics:'snapshot'},{id:'c',scope:'c',endpointId:'c',kind:'poll',intervalMs:1000,semantics:'snapshot'},{id:'ships',scope:'nyc',endpointId:'ships',kind:'websocket',semantics:'delta'}] };
const adapter: DataAdapter = {manifest,decode:p=>JSON.parse(p.payload as string) as AdapterBatch[]};
const entity = (id='one',offset=0):GeoEntity=>({id,longitude:-74,latitude:40.7,observedAt:iso(offset),properties:{label:id}});
const snapshot = (entities:GeoEntity[]=[], publishedOffset=0, inputId='a'):AdapterBatch=>({inputId,scope:inputId,kind:'snapshot',complete:true,publishedAt:iso(publishedOffset),entities});
const delta = (entities:GeoEntity[]=[],removals:{id:string;observedAt:string}[]=[]):AdapterBatch=>({inputId:'ships',scope:'nyc',kind:'delta',entities,removals});
const packet = (batch:AdapterBatch,receiptOffset=0):SourcePacket=>({adapterId:'test',inputId:batch.inputId,scope:batch.scope,receivedAt:iso(receiptOffset),payload:JSON.stringify([batch])});
const make = (save?:ConstructorParameters<typeof StateManager>[2],checkpoint?:unknown)=>new StateManager([adapter],randomUUID(),save,checkpoint);
const ingest = (state:StateManager,batch:AdapterBatch,receiptOffset=0)=>state.ingest(packet(batch,receiptOffset),now+receiptOffset);
const records = (s:StateManager)=>s.snapshot().entities;

describe('validation boundary',()=>{
  it('rejects impossible manifest thresholds and duplicate input IDs',()=>{
    expect(()=>manifestSchema.parse({...manifest,expireAfterMs:1_000})).toThrow();
    expect(()=>manifestSchema.parse({...manifest,inputs:[manifest.inputs[0],manifest.inputs[0]]})).toThrow();
  });
  it.each<Partial<GeoEntity>>([
    {longitude:181},{latitude:NaN},{observedAt:'yesterday'}, {properties:{html:'<script>alert(1)</script>'}},
    {properties:{label:'x'.repeat(257)}}, {properties:{constructor:'unsafe'}},
  ])('rejects unsafe normalized input atomically: %j',patch=>{
    const state=make();ingest(state,snapshot([entity()]));const before=state.checkpoint();
    const bad=snapshot([{...entity('two'),...patch} as GeoEntity],1000);
    expect(()=>ingest(state,bad,1000)).toThrow();expect(state.checkpoint()).toEqual(before);
  });
  it('rejects duplicate identities, mismatched scopes, semantics and incomplete snapshots',()=>{
    const state=make();
    for(const batch of [snapshot([entity(),entity()]),{...snapshot(),scope:'c'},{...snapshot(),complete:false},{...delta(),inputId:'a',scope:'a'}]) {
      const p=packet(snapshot());p.payload=JSON.stringify([batch]);expect(()=>state.ingest(p,now)).toThrow();
    }
    expect(records(state)).toEqual([]);
  });
  it('bounds packet bytes and entity count before committing',()=>{
    const state=make(),p=packet(snapshot());p.payload='é'.repeat(LIMITS.packetBytes/2+1);
    expect(()=>state.ingest(p,now)).toThrow();
    expect(()=>ingest(state,snapshot(Array.from({length:501},(_,i)=>entity(String(i)))))).toThrow();
    expect(records(state)).toHaveLength(0);
  });
  it('rejects future provider times',()=>{
    const state=make();expect(()=>ingest(state,snapshot([entity('one',60_001)]))).toThrow();
    expect(()=>ingest(state,snapshot([],60_001))).toThrow();
  });
});
describe('complete snapshots',()=>{
  it('isolates scopes and removes only after two distinct complete absent snapshots',()=>{
    const state=make();ingest(state,snapshot([entity()]));ingest(state,snapshot([entity()],0,'c'));
    ingest(state,snapshot([],1000),1000);expect(records(state)).toHaveLength(2);
    ingest(state,snapshot([],1000),2000);expect(records(state)).toHaveLength(2);
    ingest(state,snapshot([],2000),3000);expect(records(state)).toHaveLength(1);expect(records(state)[0]?.scope).toBe('c');
  });
  it('uses publication time, so a delayed old snapshot cannot remove or rewind entities',()=>{
    const state=make();ingest(state,snapshot([entity('one',2000)],2000),2000);
    ingest(state,snapshot([],1000),3000);expect(records(state)[0]?.missingSnapshots).toBe(0);
    ingest(state,snapshot([{...entity(),longitude:0}],0),4000);expect(records(state)[0]?.longitude).toBe(-74);
  });
  it('decoder errors and intentionally ignored packets never advance absence grace',()=>{
    const state=make();ingest(state,snapshot([entity()]));const p=packet(snapshot([],1000),1000);
    p.payload='invalid';expect(()=>state.ingest(p,now+1000)).toThrow();
    p.payload='[]';expect(state.ingest(p,now+1000)).toBeNull();expect(records(state)[0]?.missingSnapshots).toBe(0);
  });
  it('repeated observations stay old while genuine presence resets absence grace',()=>{
    const state=make();ingest(state,snapshot([entity()]));ingest(state,snapshot([],1000),1000);
    ingest(state,snapshot([entity()],2000),2000);expect(records(state)[0]?.missingSnapshots).toBe(0);expect(records(state)[0]?.receivedAt).toBe(iso());
    state.sweep(now+10_000);expect(records(state)[0]?.stale).toBe(true);
  });
});
describe('delta ordering and deletion',()=>{
  it('preserves unrelated vessels and orders each entity independently',()=>{
    const state=make();ingest(state,delta([entity('one',2000)]),2000);
    ingest(state,delta([entity('two',1000)]),3000);expect(records(state)).toHaveLength(2);
    ingest(state,delta([{...entity('one',1000),longitude:0}]),4000);expect(records(state).find(e=>e.id==='one')?.longitude).toBe(-74);
  });
  it('does not apply stale removals; a deletion prevents resurrection across restart',()=>{
    let state=make();ingest(state,delta([entity('one',1000)]),1000);
    ingest(state,delta([],[{id:'one',observedAt:iso()}]),2000);expect(records(state)).toHaveLength(1);
    ingest(state,delta([],[{id:'one',observedAt:iso(3000)}]),3000);expect(records(state)).toHaveLength(0);
    state=make(undefined,state.checkpoint());ingest(state,delta([entity('one',2000)]),4000);expect(records(state)).toHaveLength(0);
    ingest(state,delta([entity('one',5000)]),5000);expect(records(state)).toHaveLength(1);
  });
  it('uses first accepted value for conflicting equal-time reports',()=>{
    const state=make();ingest(state,delta([entity()]));ingest(state,delta([{...entity(),longitude:0}]),1000);expect(records(state)[0]?.longitude).toBe(-74);
  });
});
describe('durability, freshness and bounds',()=>{
  it('durable failure cannot change memory, publication revision or ordering',()=>{
    let fail=false;const state=make(()=>{if(fail)throw new Error('disk full');});ingest(state,snapshot([entity()]));const before=state.snapshot();fail=true;
    expect(()=>ingest(state,snapshot([],1000),1000)).toThrow('disk full');expect(state.snapshot()).toEqual(before);
    fail=false;expect(ingest(state,snapshot([],1000),1000)?.revision).toBe(2);
  });
  it('restores watermarks and grace, marks stale, expires and rejects expired replays',()=>{
    let state=make();ingest(state,snapshot([entity()]));ingest(state,snapshot([],1000),1000);
    state=make(undefined,state.checkpoint());ingest(state,snapshot([],1000),2000);expect(records(state)).toHaveLength(1);
    state.sweep(now+10_000);expect(records(state)[0]?.stale).toBe(true);
    expect(state.sweep(now+30_000)?.removed).toEqual([entityKey('test','a','a','one')]);
    ingest(state,snapshot([entity()],31_000),31_000);expect(records(state)).toHaveLength(0);
    state.sweep(now+LIMITS.tombstoneTtlMs+30_001);expect(Object.keys(state.checkpoint().tombstones)).toHaveLength(0);
  });
  it('rejects a batch beyond global entity capacity without partial application',()=>{
    const state=make();for(let n=0;n<4;n++)ingest(state,delta(Array.from({length:500},(_,i)=>entity(String(n*500+i)))));
    expect(records(state)).toHaveLength(2000);expect(()=>ingest(state,delta([entity('overflow')]))).toThrow('capacity');expect(records(state)).toHaveLength(2000);
  });
  it('returns detached snapshots',()=>{
    const state=make();ingest(state,snapshot([entity()]));state.snapshot().entities[0]!.longitude=0;expect(records(state)[0]?.longitude).toBe(-74);
  });
});
