import { z } from 'zod';

const Common = {
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
} as const;

export const ApiEnvSchema = z.object({
  ...Common,
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  BACKEND_TO_WA_SHARED_SECRET: z.string().min(16),
});
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export const WorkerEnvSchema = z.object({
  ...Common,
  WORKER_ID: z.string().min(1),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(100).default(10),
  MAX_RSS_MB: z.coerce.number().int().min(512).default(5_000),
  PUPPETEER_EXECUTABLE_PATH: z.string().default('/usr/bin/chromium'),
  WWEBJS_CACHE_DIR: z.string().default('./wwebjs-cache'),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  OUTBOUND_MEDIA_ALLOWED_HOSTS: z.string().default(''),
  OUTBOUND_MEDIA_MAX_BYTES: z.coerce.number().int().min(1).default(16_000_000),

  RATELIMIT_CAPACITY: z.coerce.number().int().min(1).default(10),
  RATELIMIT_REFILL_PER_SEC: z.coerce.number().min(0.01).default(1),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export const DispatcherEnvSchema = z.object({
  ...Common,
  DISPATCHER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  DISPATCHER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});
export type DispatcherEnv = z.infer<typeof DispatcherEnvSchema>;

export const loadEnv = <T extends z.ZodTypeAny>(schema: T, source = process.env): z.infer<T> => {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
};

export const parseAllowedHosts = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
