import pg from 'pg';
import { log } from './log.js';

let pool: pg.Pool | null = null;

export const getPool = (databaseUrl: string): pg.Pool => {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    log.error({ err }, 'pg pool error');
  });
  return pool;
};

export const closePool = async (): Promise<void> => {
  if (!pool) return;
  await pool.end();
  pool = null;
};

export const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<pg.QueryResult<T>> => {
  if (!pool) throw new Error('pg pool not initialised');
  return pool.query<T>(sql, params as unknown[]);
};

export const withTx = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
  if (!pool) throw new Error('pg pool not initialised');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
