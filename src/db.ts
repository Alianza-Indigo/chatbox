import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Append explicit pool limits to DATABASE_URL unless already set.
// web + worker each get 10 connections → max 20 active against Postgres.
const dbUrl = (() => {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('connection_limit=')) {
    return url + (url.includes('?') ? '&' : '?') + 'connection_limit=10&pool_timeout=10';
  }
  return url;
})();

export const db: PrismaClient = globalThis.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  datasources: { db: { url: dbUrl } },
});

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = db;
}
