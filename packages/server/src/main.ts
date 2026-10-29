import { resolve } from 'node:path';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const { app } = await createApp({
  databasePath: process.env.DATABASE_PATH ?? resolve(import.meta.dirname, '../../../.data/geoatlas.sqlite'),
  ...(process.env.WEB_ORIGIN ? { origins: process.env.WEB_ORIGIN.split(',').map(s => s.trim()) } : {}),
  serveWeb: true,
});
try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
  console.log(`GeoAtlas synthetic observatory: http://localhost:${port}`);
} catch (error) { await app.close(); throw error; }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
