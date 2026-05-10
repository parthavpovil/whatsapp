import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pgContainer: StartedTestContainer | null = null;
let redisContainer: StartedTestContainer | null = null;

export const setup = async (): Promise<void> => {
  // If URLs already set (e.g., running against docker-compose stack), skip container startup.
  if (process.env['TEST_DATABASE_URL'] && process.env['TEST_REDIS_URL']) {
    runMigrations(process.env['TEST_DATABASE_URL']);
    return;
  }

  console.log('[global-setup] Starting Postgres...');
  pgContainer = await new GenericContainer('postgres:16')
    .withEnvironment({
      POSTGRES_DB: 'wa_test',
      POSTGRES_USER: 'wa',
      POSTGRES_PASSWORD: 'wa_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
    .start();

  console.log('[global-setup] Starting Redis...');
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  const pgUrl = `postgres://wa:wa_test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/wa_test`;
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  process.env['TEST_DATABASE_URL'] = pgUrl;
  process.env['TEST_REDIS_URL'] = redisUrl;

  runMigrations(pgUrl);
  console.log('[global-setup] Ready.');
};

export const teardown = async (): Promise<void> => {
  await pgContainer?.stop();
  await redisContainer?.stop();
};

const runMigrations = (dbUrl: string): void => {
  console.log('[global-setup] Running migrations...');
  execSync('node node_modules/.bin/node-pg-migrate up -m migrations -j js', {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit',
  });
};
