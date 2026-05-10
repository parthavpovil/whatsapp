import type { Redis } from 'ioredis';
import { RedisKeys } from '@wa/shared';
import { query } from './db.js';
import { log } from './log.js';
import { leaseTakeoversTotal } from './metrics.js';

const TICK_INTERVAL_MS = 5_000;
const ADVISORY_LOCK_KEY = 'allocator';

type LiveWorker = { worker_id: string; capacity: number };

const liveWorkers = async (redis: Redis): Promise<LiveWorker[]> => {
  // Find all worker:heartbeat:* keys, then fetch their capacity.
  const stream = redis.scanStream({ match: 'worker:heartbeat:*', count: 100 });
  const workerIds: string[] = [];
  for await (const keys of stream as unknown as AsyncIterable<string[]>) {
    for (const k of keys) {
      const id = k.slice('worker:heartbeat:'.length);
      // Skip workers that are draining.
      const draining = await redis.get(RedisKeys.workerDraining(id));
      if (draining === '1') continue;
      workerIds.push(id);
    }
  }
  if (workerIds.length === 0) return [];
  const capacities = await Promise.all(
    workerIds.map(async (id) => {
      const raw = await redis.get(RedisKeys.workerCapacity(id));
      const capacity = raw ? Number.parseInt(raw, 10) : 0;
      return { worker_id: id, capacity };
    }),
  );
  return capacities;
};

type UnassignedRow = { id: string };

const oneTick = async (redis: Redis): Promise<void> => {
  // pg_try_advisory_lock returns false if another api replica holds it; skip this tick.
  const lockResult = await query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
    [ADVISORY_LOCK_KEY],
  );
  const acquired = lockResult.rows[0]?.acquired === true;
  if (!acquired) return;
  try {
    const candidates = await query<UnassignedRow>(
      `SELECT id FROM wa_accounts
        WHERE status NOT IN ('banned','disconnected')
          AND (worker_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY created_at
        LIMIT 50`,
    );
    if (candidates.rows.length === 0) return;
    const workers = await liveWorkers(redis);
    if (workers.length === 0) {
      log.warn({ pending: candidates.rows.length }, 'allocator: no live workers');
      return;
    }
    workers.sort((a, b) => a.capacity - b.capacity);

    for (const { id } of candidates.rows) {
      const target = workers[0];
      if (!target) break;
      // Atomic claim — race-safe at the DB level.
      const claim = await query<{ id: string }>(
        `UPDATE wa_accounts
            SET worker_id = $1,
                lease_expires_at = now() + interval '30 seconds',
                updated_at = now()
          WHERE id = $2
            AND (worker_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
          RETURNING id`,
        [target.worker_id, id],
      );
      if (claim.rowCount && claim.rowCount > 0) {
        target.capacity += 1;
        workers.sort((a, b) => a.capacity - b.capacity);
        leaseTakeoversTotal.inc();
        log.info({ wa_account_id: id, worker_id: target.worker_id }, 'allocator: assigned');
      }
    }
  } finally {
    await query(`SELECT pg_advisory_unlock(hashtext($1))`, [ADVISORY_LOCK_KEY]).catch(() => undefined);
  }
};

export const startAllocator = (redis: Redis): { stop: () => void } => {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await oneTick(redis);
    } catch (err) {
      log.error({ err }, 'allocator tick failed');
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
    }
  };
  let timer: NodeJS.Timeout = setTimeout(tick, TICK_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
