import { readFile, writeFile } from 'node:fs/promises';
import { query } from './db.js';
import { log } from './log.js';

// wwebjs RemoteAuth Store interface (1.26.x).
// Calls — note: `session` arrives prefixed: 'RemoteAuth-<clientId>'.
//   sessionExists({ session }) -> boolean
//   save({ session }) — wwebjs has just produced a zip at <dataPath>/<session>.zip; we read+upload
//   extract({ session, path }) — we download bytes and write them to `path`
//   delete({ session }) — remove our row
//
// Our `clientId` IS the wa_account_id (UUID). We strip 'RemoteAuth-' to get the PK.
const PREFIX = 'RemoteAuth-';

const toAccountId = (session: string): string =>
  session.startsWith(PREFIX) ? session.slice(PREFIX.length) : session;

export type StoreOpts = {
  // wwebjs writes/reads the zip at this directory. We need it for `save` to know
  // where the freshly-built zip lives. wwebjs default is process.cwd() but we
  // pass it explicitly to keep behavior pinned.
  dataPath: string;
};

export class PostgresStore {
  constructor(private readonly opts: StoreOpts) {}

  async sessionExists({ session }: { session: string }): Promise<boolean> {
    const id = toAccountId(session);
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM wa_session_blobs WHERE wa_account_id = $1) AS exists`,
      [id],
    );
    return result.rows[0]?.exists === true;
  }

  async save({ session }: { session: string }): Promise<void> {
    const id = toAccountId(session);
    const zipPath = `${this.opts.dataPath}/${session}.zip`;
    const buf = await readFile(zipPath);
    // UPSERT: PK is wa_account_id, so concurrent saves serialize naturally.
    await query(
      `INSERT INTO wa_session_blobs (wa_account_id, blob, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (wa_account_id) DO UPDATE
         SET blob = EXCLUDED.blob, updated_at = now()`,
      [id, buf],
    );
    log.debug({ wa_account_id: id, bytes: buf.length }, 'session blob saved');
  }

  async extract({ session, path }: { session: string; path: string }): Promise<void> {
    const id = toAccountId(session);
    const result = await query<{ blob: Buffer }>(
      `SELECT blob FROM wa_session_blobs WHERE wa_account_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`postgres-store: no blob for ${id}`);
    }
    await writeFile(path, row.blob);
    log.debug({ wa_account_id: id, bytes: row.blob.length, path }, 'session blob extracted');
  }

  async delete({ session }: { session: string }): Promise<void> {
    const id = toAccountId(session);
    await query(`DELETE FROM wa_session_blobs WHERE wa_account_id = $1`, [id]);
    log.info({ wa_account_id: id }, 'session blob deleted');
  }
}
