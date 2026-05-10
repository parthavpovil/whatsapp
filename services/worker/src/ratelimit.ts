import type { Redis } from 'ioredis';
import { RedisKeys } from '@wa/shared';

// Token bucket implemented in Redis Lua. Atomic refill + take.
//
// State (HASH at key):
//   tokens       — float
//   last_refill  — ms timestamp (integer string)
//
// Args:
//   KEYS[1] = ratelimit:account:{id}
//   ARGV[1] = capacity      (max tokens)
//   ARGV[2] = refill_per_sec (tokens per second)
//   ARGV[3] = now_ms         (current time, passed in to be testable)
//   ARGV[4] = ttl_sec        (key TTL — keep alive while in use)
//
// Returns: { allowed (1|0), remaining_tokens (int floor), retry_ms (int) }
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl_sec = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil or last_refill == nil then
  tokens = capacity
  last_refill = now_ms
end

local elapsed_ms = now_ms - last_refill
if elapsed_ms < 0 then elapsed_ms = 0 end
local refill = (elapsed_ms / 1000.0) * refill_per_sec
tokens = math.min(capacity, tokens + refill)

local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  -- compute ms until at least 1 token is available
  local deficit = 1 - tokens
  retry_ms = math.ceil((deficit / refill_per_sec) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now_ms)
redis.call('EXPIRE', key, ttl_sec)
return { allowed, math.floor(tokens), retry_ms }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    rateLimitTake(
      key: string,
      capacity: string,
      refillPerSec: string,
      nowMs: string,
      ttlSec: string,
    ): Promise<[number, number, number]>;
  }
}

let registered = false;

const ensureRegistered = (redis: Redis): void => {
  if (registered) return;
  redis.defineCommand('rateLimitTake', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  registered = true;
};

export type TakeResult = { allowed: true } | { allowed: false; retryMs: number };

export type RateLimiterOpts = {
  capacity: number;
  refillPerSec: number;
};

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly opts: RateLimiterOpts,
  ) {
    ensureRegistered(redis);
  }

  async take(waAccountId: string): Promise<TakeResult> {
    const ttl = Math.max(60, Math.ceil(this.opts.capacity / this.opts.refillPerSec) * 2);
    const result = await this.redis.rateLimitTake(
      RedisKeys.ratelimitAccount(waAccountId),
      String(this.opts.capacity),
      String(this.opts.refillPerSec),
      String(Date.now()),
      String(ttl),
    );
    const [allowed, , retryMs] = result;
    if (allowed === 1) return { allowed: true };
    return { allowed: false, retryMs };
  }
}
