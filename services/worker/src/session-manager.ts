import type { Redis } from 'ioredis';
import { log } from './log.js';
import { ManagedSession, ensureDataPath } from './managed-session.js';
import type { MediaConfig } from './media.js';
import type { RateLimiter } from './ratelimit.js';

export type SessionManagerOpts = {
  redis: Redis;
  dataPathRoot: string;
  puppeteerExecutablePath: string;
  webVersionCachePath: string;
  media: MediaConfig;
  rateLimiter: RateLimiter;
};

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  constructor(private readonly opts: SessionManagerOpts) {}

  size(): number {
    return this.sessions.size;
  }

  has(waAccountId: string): boolean {
    return this.sessions.has(waAccountId);
  }

  ids(): string[] {
    return Array.from(this.sessions.keys());
  }

  get(waAccountId: string): ManagedSession | undefined {
    return this.sessions.get(waAccountId);
  }

  async add(waAccountId: string): Promise<void> {
    if (this.sessions.has(waAccountId)) return;
    const dataPath = await ensureDataPath(this.opts.dataPathRoot);
    const session = new ManagedSession({
      waAccountId,
      redis: this.opts.redis,
      dataPath,
      puppeteerExecutablePath: this.opts.puppeteerExecutablePath,
      webVersionCachePath: this.opts.webVersionCachePath,
      media: this.opts.media,
      rateLimiter: this.opts.rateLimiter,
    });
    this.sessions.set(waAccountId, session);
    // initialize is slow (10–30s for Chromium boot). Fire-and-forget; failures are
    // surfaced via on-disconnected / on-auth-failure handlers.
    session.start().catch((err) => {
      log.error({ err, wa_account_id: waAccountId }, 'session.start failed');
      // Do NOT remove from map — the lease is still ours; let the next allocator
      // tick observe the wedged session via disconnected status.
    });
  }

  async remove(waAccountId: string): Promise<void> {
    const session = this.sessions.get(waAccountId);
    if (!session) return;
    this.sessions.delete(waAccountId);
    await session.destroy();
  }

  async destroyAll(): Promise<void> {
    const tasks = Array.from(this.sessions.values()).map((s) =>
      s.destroy().catch((err) => log.warn({ err }, 'destroyAll: session.destroy failed')),
    );
    this.sessions.clear();
    await Promise.all(tasks);
  }
}
