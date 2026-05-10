import type { Redis } from 'ioredis';
import { RedisKeys } from '@wa/shared';

export const writeHeartbeat = async (
  redis: Redis,
  workerId: string,
  capacity: number,
): Promise<void> => {
  const heartbeatKey = RedisKeys.workerHeartbeat(workerId);
  const capacityKey = RedisKeys.workerCapacity(workerId);
  await redis
    .multi()
    .set(heartbeatKey, new Date().toISOString(), 'EX', RedisKeys.TTL.workerHeartbeatSec)
    .set(capacityKey, String(capacity))
    .exec();
};

export const writeOwnerKey = async (
  redis: Redis,
  waAccountId: string,
  workerId: string,
): Promise<void> => {
  await redis.set(
    RedisKeys.sessionOwner(waAccountId),
    workerId,
    'EX',
    RedisKeys.TTL.sessionOwnerSec,
  );
};
