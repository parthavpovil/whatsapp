import Fastify, { type FastifyInstance } from 'fastify';
import { makeBearerAuth } from './auth.js';
import { getPool } from './db.js';
import { getRedis } from './redis.js';
import { registerAccounts } from './routes/accounts.js';
import { registerCommands } from './routes/commands.js';
import { registerHealth } from './routes/health.js';
import { registerQr } from './routes/qr.js';

export type MakeAppOpts = {
  databaseUrl: string;
  redisUrl: string;
  sharedSecret: string;
  logLevel?: string;
  nodeEnv?: string;
};

export const makeApp = (opts: MakeAppOpts): FastifyInstance => {
  getPool(opts.databaseUrl);
  const redis = getRedis(opts.redisUrl);

  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'warn',
      ...(opts.nodeEnv !== 'production' && opts.logLevel !== 'silent'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
      base: { service: 'api' },
    },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  const auth = makeBearerAuth(opts.sharedSecret);

  registerHealth(app, redis);
  registerAccounts(app, auth);
  registerQr(app, redis, auth);
  registerCommands(app, auth, opts.redisUrl);

  return app;
};
