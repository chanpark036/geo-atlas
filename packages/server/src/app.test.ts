import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { demoAdapters,transitPayload } from '@geoatlas/adapters';
import { createApp } from './app.ts';
import { IngestionRuntime,type Endpoint } from './runtime.ts';
import { StateManager } from '@geoatlas/adapter-core';
import { randomUUID } from 'node:crypto';
const apps:Awaited<ReturnType<typeof createApp>>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(({app})=>app.close()));});
const make=async(options:Parameters<typeof createApp>[0]={})=>{const result=await createApp(options);apps.push(result);return result;};
it('runs synthetic poll and stream inputs and delivers normalized state through HTTP and WebSocket',async()=>{
  const {app,runtime}=await make();await delay(30);
  const response=await app.inject('/api/snapshot');expect(response.statusCode).toBe(200);
  const snapshot=response.json();expect(snapshot.type).toBe('snapshot');expect(snapshot.entities.length).toBeGreaterThanOrEqual(7);
  expect(runtime.status().every(s=>s.status==='healthy')).toBe(true);
  expect((await app.inject('/api/catalog')).json().routes).toHaveLength(3);
  const messages:string[]=[];
  const socket=await app.injectWS('/api/live',{headers:{origin:'http://localhost:5173'}},{onInit:ws=>ws.on('message',data=>messages.push(data.toString()))});
  await delay(10);expect(JSON.parse(messages[0]!).type).toBe('snapshot');socket.close();
});
it('rejects unexpected browser origins before upgrading',async()=>{
  const {app}=await make({startRuntime:false});
  await expect(app.injectWS('/api/live',{headers:{origin:'https://untrusted.invalid'}})).rejects.toThrow();
});
it('is read-only and reconnects with a full snapshot at the latest revision',async()=>{
  const {app,state,publish}=await make({startRuntime:false});
  const messages:string[]=[];const socket=await app.injectWS('/api/live',{}, {onInit:ws=>ws.on('message',data=>messages.push(data.toString()))});
  const now=Date.now(),change=state.ingest({adapterId:'demo-transit',inputId:'a',scope:'a',receivedAt:new Date(now).toISOString(),payload:transitPayload('A',now)});
  publish(change!);await delay(10);expect(messages.map(m=>JSON.parse(m).type)).toEqual(['snapshot','change']);
  const closed=new Promise<number>(resolve=>socket.once('close',code=>resolve(code)));socket.send('subscribe to everything');expect(await closed).toBe(1008);
  const nextMessages:string[]=[];const next=await app.injectWS('/api/live',{}, {onInit:ws=>ws.on('message',data=>nextMessages.push(data.toString()))});
  await delay(10);expect(JSON.parse(nextMessages[0]!)).toMatchObject({type:'snapshot',revision:1});expect(JSON.parse(nextMessages[0]!).entities).toHaveLength(2);next.close();
});
it('persists current state, restores it in a new epoch, and does not require upstream credentials',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'geoatlas-'));
  try{
    const path=join(directory,'state.sqlite');const first=await make({databasePath:path,startRuntime:false});
    const now=Date.now();first.state.ingest({adapterId:'demo-transit',inputId:'a',scope:'a',receivedAt:new Date(now).toISOString(),payload:transitPayload('A',now)});
    const before=first.state.snapshot();await first.app.close();apps.splice(apps.indexOf(first),1);
    const second=await make({databasePath:path,startRuntime:false});const after=second.state.snapshot();
    expect(after.entities).toEqual(before.entities);expect(after.epoch).not.toBe(before.epoch);expect(after.revision).toBe(0);
    expect(JSON.stringify((await second.app.inject('/api/status')).json())).not.toMatch(/APIKey|Authorization|password/);
    await second.app.close();apps.splice(apps.indexOf(second),1);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
it('fails closed on an undeclared endpoint',()=>{
  const state=new StateManager(demoAdapters,randomUUID());expect(()=>new IngestionRuntime(state,new Map(),()=>{})).toThrow('endpoint');
});
it('aborts a stalled poll promptly on shutdown',async()=>{
  const adapter=demoAdapters[0]!,state=new StateManager([adapter],randomUUID());
  const endpoints=new Map<string,Endpoint>(adapter.manifest.inputs.map(i=>[i.endpointId,{kind:'poll',timeoutMs:60000,read:()=>new Promise(()=>{})}]));
  const runtime=new IngestionRuntime(state,endpoints,()=>{});runtime.start();await runtime.stop();expect(runtime.status().every(s=>s.status==='stopped')).toBe(true);
});
it('sanitizes failures, retries without overlapping polls, and preserves prior state',async()=>{
  const adapter={...demoAdapters[0]!,manifest:{...demoAdapters[0]!.manifest,inputs:[demoAdapters[0]!.manifest.inputs[0]!]}};
  const state=new StateManager([adapter],randomUUID());let calls=0,active=0,maxActive=0;
  const endpoints=new Map<string,Endpoint>([['demo-a',{kind:'poll',timeoutMs:1000,async read(){active++;maxActive=Math.max(maxActive,active);calls++;await delay(10);active--;throw new Error('APIKey=SECRET-CANARY');}}]]);
  const runtime=new IngestionRuntime(state,endpoints,()=>{},()=>0);runtime.start();await delay(40);
  expect(runtime.status()[0]?.status).toBe('retrying');expect(JSON.stringify(runtime.status())).not.toContain('SECRET-CANARY');
  await delay(430);await runtime.stop();expect(calls).toBeGreaterThanOrEqual(2);expect(maxActive).toBe(1);expect(state.snapshot().entities).toEqual([]);
});

it('serves static MTA geometry locally and permits only the approved map origin in CSP', async () => {
  const { app } = await make({ startRuntime: false });
  const response = await app.inject('/api/catalog');
  const catalog = response.json();
  expect(catalog.source.name).toContain('MTA');
  expect(catalog.routes.find((route: { id: string }) => route.id === 'C').stops).toHaveLength(11);
  const csp = response.headers['content-security-policy'] as string;
  expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org;");
  expect(csp).not.toContain('https:;');
  expect(csp).not.toContain('*');
});
