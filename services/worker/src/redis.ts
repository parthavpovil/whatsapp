import { Redis } from 'ioredis';
import { log } from './log.js';

let control: Redis | null = null;

// Control connection: GET/SET/PUBLISH/etc. Used for everything except BRPOP.
// BRPOP blocks the connection — must use a *separate* duplicate.
export const getControl = (url: string): Redis => {
  if (control) return control;
  control = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  control.on('error', (err) => log.error({ err }, 'redis control error'));
  return control;
};

export const newBlockingClient = (url: string): Redis => {
  // Use a dedicated client for BRPOP. maxRetriesPerRequest=null lets blocking commands
  // wait indefinitely without ioredis cancelling them.
  const r = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  r.on('error', (err) => log.error({ err }, 'redis blocking client error'));
  return r;
};

export const closeRedis = async (): Promise<void> => {
  if (!control) return;
  control.disconnect();
  control = null;
};
