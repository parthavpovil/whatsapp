import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Redis } from 'ioredis';
import wwebjs from 'whatsapp-web.js';
import { type OutboundCommand, messageSendFailed, messageSentAck, newEventId } from '@wa/shared';
import { withTx } from './db.js';
import { log } from './log.js';
import { onAuthFailure } from './handlers/on-auth-failure.js';
import { onAuthenticated } from './handlers/on-authenticated.js';
import { onDisconnected } from './handlers/on-disconnected.js';
import { onMessage } from './handlers/on-message.js';
import { onMessageAck } from './handlers/on-message-ack.js';
import { onQr } from './handlers/on-qr.js';
import { onReady } from './handlers/on-ready.js';
import { type MediaConfig, downloadOutboundMedia } from './media.js';
import { messagesFailedTotal, messagesSentTotal } from './metrics.js';
import { insertOutboxTx } from './outbox.js';
import { PostgresStore } from './postgres-store.js';
import type { RateLimiter } from './ratelimit.js';

const { Client, RemoteAuth, MessageMedia } = wwebjs;

export type ManagedSessionOpts = {
  waAccountId: string;
  redis: Redis;
  dataPath: string;
  puppeteerExecutablePath: string;
  webVersionCachePath: string;
  media: MediaConfig;
  rateLimiter: RateLimiter;
};

export class ManagedSession {
  readonly waAccountId: string;
  private readonly client: InstanceType<typeof Client>;
  private readonly redis: Redis;
  private readonly media: MediaConfig;
  private readonly rateLimiter: RateLimiter;
  // Per-session async chain: serializes sends within an account, gated by token bucket.
  // QueueConsumer calls enqueue() and returns immediately so other accounts aren't blocked.
  private chain: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(opts: ManagedSessionOpts) {
    this.waAccountId = opts.waAccountId;
    this.redis = opts.redis;
    this.media = opts.media;
    this.rateLimiter = opts.rateLimiter;
    const store = new PostgresStore({ dataPath: opts.dataPath });
    this.client = new Client({
      authStrategy: new RemoteAuth({
        clientId: opts.waAccountId,
        store,
        backupSyncIntervalMs: 60_000,
        dataPath: opts.dataPath,
      }),
      puppeteer: {
        executablePath: opts.puppeteerExecutablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-extensions',
          '--disable-background-timer-throttling',
        ],
      },
      webVersionCache: { type: 'local', path: opts.webVersionCachePath },
    });
    this.wireHandlers();
  }

  private wireHandlers(): void {
    const id = this.waAccountId;
    this.client.on('qr', (qr: string) => {
      void onQr(this.redis, id, qr).catch((err) => log.error({ err, id }, 'on-qr failed'));
    });
    this.client.on('authenticated', () => {
      void onAuthenticated(id).catch((err) => log.error({ err, id }, 'on-authenticated failed'));
    });
    this.client.on('ready', () => {
      const phone = this.client.info?.wid?.user ?? '';
      void onReady(this.redis, id, phone).catch((err) =>
        log.error({ err, id }, 'on-ready failed'),
      );
    });
    this.client.on('disconnected', (reason: string) => {
      void onDisconnected(id, reason).catch((err) =>
        log.error({ err, id }, 'on-disconnected failed'),
      );
    });
    this.client.on('auth_failure', (reason: string) => {
      void onAuthFailure(this.redis, id, reason).catch((err) =>
        log.error({ err, id }, 'on-auth-failure failed'),
      );
    });
    this.client.on(
      'message_ack',
      (msg: { id: { _serialized: string }; to: string }, ack: number) => {
        void onMessageAck(id, msg.id._serialized, msg.to, ack).catch((err) =>
          log.error({ err, id }, 'on-message-ack failed'),
        );
      },
    );
    this.client.on('message', (msg: Parameters<typeof onMessage>[2]) => {
      void onMessage(this.redis, id, msg, this.media).catch((err) =>
        log.error({ err, id }, 'on-message failed'),
      );
    });
  }

  enqueue(cmd: OutboundCommand): void {
    this.chain = this.chain
      .then(() => this.sendGated(cmd))
      .catch((err) => log.error({ err, command_id: cmd.command_id }, 'send chain error'));
  }

  private async sendGated(cmd: OutboundCommand): Promise<void> {
    if (this.destroyed) return;
    // Token bucket: loop until allowed. retryMs is bounded by refill rate.
    while (!this.destroyed) {
      const result = await this.rateLimiter.take(this.waAccountId);
      if (result.allowed) break;
      await new Promise((resolve) => setTimeout(resolve, result.retryMs));
    }
    if (this.destroyed) return;
    await this.send(cmd);
  }

  async send(cmd: OutboundCommand): Promise<void> {
    const accountId = this.waAccountId;
    // Mark in-flight first so retried-from-api commands don't double-send.
    await withTx(async (client) => {
      const updated = await client.query<{ status: string }>(
        `UPDATE outbound_commands
            SET status='sending', attempts=attempts+1
          WHERE command_id=$1 AND status IN ('queued','failed')
          RETURNING status`,
        [cmd.command_id],
      );
      if (updated.rowCount === 0) {
        // Already sent or sending elsewhere — nothing to do.
        log.warn({ command_id: cmd.command_id }, 'send: command not in queued state, skipping');
        return;
      }
    });

    try {
      const sent = cmd.type === 'text'
        ? await this.client.sendMessage(cmd.to, cmd.payload.body)
        : await (async () => {
            const fetched = await downloadOutboundMedia(this.media, cmd.payload.media_url);
            const filename = cmd.payload.filename ?? `media.${cmd.payload.mime_type.split('/')[1] ?? 'bin'}`;
            const media = new MessageMedia(
              cmd.payload.mime_type,
              fetched.data.toString('base64'),
              filename,
            );
            const opts: { caption?: string } = {};
            if (cmd.payload.body !== undefined) opts.caption = cmd.payload.body;
            return this.client.sendMessage(cmd.to, media, opts);
          })();
      const waMessageId = sent.id._serialized;
      await withTx(async (client) => {
        await client.query(
          `UPDATE outbound_commands
              SET status='sent', wa_message_id=$2, sent_at=now()
            WHERE command_id=$1`,
          [cmd.command_id, waMessageId],
        );
        await insertOutboxTx(client, messageSentAck({
          event_id: newEventId(),
          wa_account_id: accountId,
          command_id: cmd.command_id,
          wa_message_id: waMessageId,
          to: cmd.to,
        }));
      });
      messagesSentTotal.inc({ type: cmd.type });
      log.info({ command_id: cmd.command_id, wa_message_id: waMessageId }, 'sent');
    } catch (err) {
      messagesFailedTotal.inc();
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, command_id: cmd.command_id }, 'send failed');
      await withTx(async (client) => {
        const result = await client.query<{ attempts: number }>(
          `UPDATE outbound_commands
              SET status='failed', last_error=$2
            WHERE command_id=$1
            RETURNING attempts`,
          [cmd.command_id, errMsg],
        );
        const attempts = result.rows[0]?.attempts ?? 1;
        await insertOutboxTx(client, messageSendFailed({
          event_id: newEventId(),
          wa_account_id: accountId,
          command_id: cmd.command_id,
          error: errMsg,
          attempts,
        }));
      });
      throw err;
    }
  }

  async start(): Promise<void> {
    log.info({ wa_account_id: this.waAccountId }, 'session: initializing');
    await this.client.initialize();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    log.info({ wa_account_id: this.waAccountId }, 'session: destroying');
    // Race against a 5s timeout — Chromium can wedge.
    const destroyP = (async (): Promise<void> => {
      try {
        await this.client.destroy();
      } catch (err) {
        log.warn({ err, wa_account_id: this.waAccountId }, 'session.destroy threw');
      }
    })();
    const timeoutP = new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000));
    await Promise.race([destroyP, timeoutP]);
    // Hard-kill the browser process if still alive.
    try {
      const proc = this.client.pupBrowser?.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch (err) {
      log.warn({ err, wa_account_id: this.waAccountId }, 'session: SIGKILL on browser failed');
    }
  }
}

export const ensureDataPath = async (root: string): Promise<string> => {
  const abs = resolve(root);
  await mkdir(abs, { recursive: true });
  return abs;
};
