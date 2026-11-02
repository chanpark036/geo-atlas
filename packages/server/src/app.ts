import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  StateManager,
  LIMITS,
  BASEMAP,
  type ChangeMessage,
  type DataAdapter,
  type Catalog,
} from '@geoatlas/adapter-core';
import { demoAdapters, demoCatalog, maritimeAdapter, createMtaAdapter } from '@geoatlas/adapters';
import type { WebSocket } from 'ws';
import { demoEndpoints, mtaEndpoints } from './endpoints.ts';
import { IngestionRuntime, type Endpoint } from './runtime.ts';
import { SqliteStore } from './store.ts';

export interface AppOptions {
  transitSource?: 'synthetic' | 'mta';
  databasePath?: string;
  origins?: readonly string[];
  startRuntime?: boolean;
  serveWeb?: boolean;
  adapters?: readonly DataAdapter[];
  endpoints?: ReadonlyMap<string, Endpoint>;
  catalog?: Catalog;
}
export async function createApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1024, requestTimeout: 10_000 });
  const mode = options.transitSource ?? 'synthetic';
  const adapters =
    options.adapters ??
    (mode === 'mta'
      ? [createMtaAdapter(options.catalog ?? demoCatalog), maritimeAdapter]
      : demoAdapters);
  const store = new SqliteStore(options.databasePath ?? ':memory:');
  let state: StateManager;
  try {
    state = new StateManager(adapters, randomUUID(), (c) => store.save(c), store.load());
    state.sweep();
  } catch (error) {
    store.close();
    throw error;
  }
  const peers = new Map<WebSocket, boolean>();
  const origins = new Set(
    options.origins ?? [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
    ],
  );
  const send = (socket: WebSocket, payload: string) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount + Buffer.byteLength(payload) > LIMITS.wireBytes * 2) {
      socket.terminate();
      return;
    }
    socket.send(payload, (error) => {
      if (error) socket.terminate();
    });
  };
  const publish = (change: ChangeMessage) => {
    const payload = JSON.stringify(change);
    for (const socket of peers.keys()) send(socket, payload);
  };
  const runtime = new IngestionRuntime(
    state,
    options.endpoints ?? (mode === 'mta' ? mtaEndpoints() : demoEndpoints()),
    publish,
  );
  await app.register(websocket, { options: { maxPayload: 1024, perMessageDeflate: false } });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${BASEMAP.origin}; connect-src 'self' ${BASEMAP.origin}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
  });
  app.get('/api/health', () => ({ ok: true, mode }));
  app.get('/api/snapshot', () => state.snapshot());
  app.get('/api/catalog', () => options.catalog ?? demoCatalog);
  app.get('/api/status', () => ({
    mode,
    sources: runtime.status(),
    manifests: state.manifests,
    entities: state.snapshot().entities.length,
  }));
  app.get(
    '/api/live',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin && !origins.has(request.headers.origin))
          return reply.code(403).send({ error: 'Origin rejected' });
        if (peers.size >= 32) return reply.code(503).send({ error: 'Connection limit reached' });
      },
    },
    (socket) => {
      // Registration and snapshot happen in one event-loop turn, so no change can fall between them.
      peers.set(socket, true);
      socket.on('pong', () => peers.set(socket, true));
      socket.on('error', () => socket.terminate());
      socket.on('close', () => peers.delete(socket));
      socket.on('message', () => {
        socket.close(1008, 'Read-only stream');
      });
      send(socket, JSON.stringify(state.snapshot()));
    },
  );
  const sweep = setInterval(() => {
    try {
      const change = state.sweep();
      if (change) publish(change);
    } catch {
      app.log.error('State maintenance failed');
    }
  }, 1_000);
  const heartbeat = setInterval(() => {
    for (const [socket, alive] of peers) {
      if (!alive) {
        socket.terminate();
        continue;
      }
      peers.set(socket, false);
      socket.ping();
    }
  }, 15_000);
  sweep.unref();
  heartbeat.unref();
  if (options.serveWeb) {
    const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    if (existsSync(root)) await app.register(fastifyStatic, { root });
  }
  app.addHook('preClose', async () => {
    clearInterval(sweep);
    clearInterval(heartbeat);
    await runtime.stop();
    for (const socket of peers.keys()) socket.terminate();
    peers.clear();
  });
  app.addHook('onClose', async () => {
    store.close();
  });
  if (options.startRuntime !== false) runtime.start();
  await app.ready();
  return { app, state, runtime, publish };
}
