import { Redis } from 'ioredis';
import { log } from './log.js';

let client: Redis | null = null;

export const getRedis = (url: string): Redis => {
  if (client) return client;
  client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  client.on('error', (err) => log.error({ err }, 'redis error'));
  return client;
};

export const closeRedis = async (): Promise<void> => {
  if (!client) return;
  client.disconnect();
  client = null;
};
