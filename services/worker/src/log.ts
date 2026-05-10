import { pino } from 'pino';

const workerId = process.env.WORKER_ID ?? 'worker-unknown';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker', worker_id: workerId },
  ...(process.env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
