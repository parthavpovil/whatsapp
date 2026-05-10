import { type QueueMessage, QueueMessageSchema, RedisKeys } from '@wa/shared';
import type { Redis } from 'ioredis';
import { log } from './log.js';
import type { SessionManager } from './session-manager.js';

const SENTINEL = '__SHUTDOWN__';

export type QueueConsumerOpts = {
  brpopClient: Redis;
  workerId: string;
  sessions: SessionManager;
};

export class QueueConsumer {
  private stopped = false;
  constructor(private readonly opts: QueueConsumerOpts) {}

  async run(): Promise<void> {
    const queueKey = RedisKeys.workerQueue(this.opts.workerId);
    log.info({ queue: queueKey }, 'queue consumer: started');
    while (!this.stopped) {
      try {
        // BRPOP blocks until an item is available. Returns [key, value] or null on timeout (we use 0=infinite).
        const result = await this.opts.brpopClient.brpop(queueKey, 0);
        if (this.stopped || !result) continue;
        const [, raw] = result;
        if (raw === SENTINEL) break;
        await this.handle(raw);
      } catch (err) {
        if (this.stopped) break;
        log.error({ err }, 'queue consumer: error, backing off');
        await sleep(1_000);
      }
    }
    log.info('queue consumer: stopped');
  }

  private async handle(raw: string): Promise<void> {
    let parsed: QueueMessage;
    try {
      parsed = QueueMessageSchema.parse(JSON.parse(raw));
    } catch (err) {
      log.error({ err, raw }, 'queue consumer: bad message, dropping');
      return;
    }
    const cmd = parsed.command;
    const session = this.opts.sessions.get(cmd.wa_account_id);
    if (!session) {
      // We don't own this account anymore — drop. The api will re-route the next
      // command via session:owner; for in-flight commands, the backend will retry
      // by command_id and we'll pick it up there.
      log.warn(
        { wa_account_id: cmd.wa_account_id, command_id: cmd.command_id },
        'queue consumer: account not owned by us, dropping',
      );
      return;
    }
    // Non-blocking: enqueue onto the per-session async chain. Send is gated by the
    // token bucket inside ManagedSession.sendGated; the BRPOP loop returns immediately.
    session.enqueue(cmd);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Push a sentinel onto the queue so BRPOP unblocks.
    try {
      await this.opts.brpopClient.lpush(RedisKeys.workerQueue(this.opts.workerId), SENTINEL);
    } catch {
      // if redis is dead, the consumer will exit on its own when its loop errors
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
