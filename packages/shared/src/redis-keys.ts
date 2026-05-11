// Single source of truth for every Redis key the service uses.
// Add new keys here, never inline.

export const sessionOwner = (waAccountId: string): string => `session:owner:${waAccountId}`;

export const workerHeartbeat = (workerId: string): string => `worker:heartbeat:${workerId}`;
export const workerCapacity = (workerId: string): string => `worker:capacity:${workerId}`;
export const workerDraining = (workerId: string): string => `worker:draining:${workerId}`;

export const workerQueue = (workerId: string): string => `queue:worker:${workerId}`;

export const dedupCommand = (commandId: string): string => `dedup:command:${commandId}`;
export const dedupEvent = (waAccountId: string, waMessageId: string): string =>
  `dedup:event:${waAccountId}:${waMessageId}`;

export const ratelimitAccount = (waAccountId: string): string => `ratelimit:account:${waAccountId}`;

export const sessionQr = (waAccountId: string): string => `session:qr:${waAccountId}`;
export const qrChannel = (waAccountId: string): string => `qr:${waAccountId}`;

export const authFailures = (waAccountId: string): string => `auth_failures:${waAccountId}`;

export const pairingPhone = (waAccountId: string): string => `pairing:phone:${waAccountId}`;
export const pairingCode = (waAccountId: string): string => `pairing:code:${waAccountId}`;
export const pairingChannel = (waAccountId: string): string => `pairing:channel:${waAccountId}`;

// TTL constants (seconds) — kept here so we have one place to tune lease windows.
export const TTL = {
  sessionOwnerSec: 30,
  workerHeartbeatSec: 30,
  dedupCommandSec: 86_400, // 24h
  dedupEventSec: 86_400, // 24h
  sessionQrSec: 60,
  authFailuresSec: 3_600, // 1h
  pairingPhoneSec: 300,
  pairingCodeSec: 120,
} as const;
