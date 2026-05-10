import type { Redis } from 'ioredis';
import { messageIncoming, newEventId } from '@wa/shared';
import { withTx } from '../db.js';
import { dedupPgTx, dedupRedis } from '../dedup.js';
import { log } from '../log.js';
import { type MediaConfig, uploadInboundMedia } from '../media.js';
import { messagesIncomingTotal } from '../metrics.js';
import { insertOutboxTx } from '../outbox.js';

// wwebjs Message shape (subset we use here). Full type lives in whatsapp-web.js typings.
type WAMessage = {
  id: { _serialized: string };
  from: string;
  to: string;
  body: string;
  type: string; // 'chat' | 'image' | 'document' | 'audio' | 'video' | 'ptt' | ...
  fromMe: boolean;
  timestamp: number;
  hasMedia?: boolean;
  _data?: { notifyName?: string };
  downloadMedia?: () => Promise<{ data: string; mimetype: string; filename?: string } | null>;
};

const mapType = (waType: string): 'text' | 'image' | 'document' | 'audio' | 'video' => {
  if (waType === 'chat') return 'text';
  if (waType === 'ptt') return 'audio';
  if (waType === 'image' || waType === 'document' || waType === 'audio' || waType === 'video') {
    return waType;
  }
  return 'text';
};

export const onMessage = async (
  redis: Redis,
  waAccountId: string,
  msg: WAMessage,
  media: MediaConfig,
): Promise<void> => {
  if (msg.fromMe) return;

  const waMessageId = msg.id._serialized;
  // Stage 1: cheap Redis dedup. If duplicate, drop without DB I/O.
  const fresh = await dedupRedis(redis, waAccountId, waMessageId);
  if (!fresh) {
    log.debug({ wa_account_id: waAccountId, wa_message_id: waMessageId }, 'inbound: redis dedup');
    return;
  }

  // If the message has media, download and upload to S3 BEFORE the DB tx so we
  // don't hold a tx open for an HTTP/S3 round trip. If the upload fails we still
  // enqueue the event without media_url — better to deliver the text/metadata than nothing.
  let mediaUrl: string | undefined;
  let mediaMime: string | undefined;
  if (msg.hasMedia && msg.downloadMedia) {
    try {
      // wwebjs occasionally returns null on transient errors; retry once.
      let downloaded = await msg.downloadMedia();
      if (!downloaded) downloaded = await msg.downloadMedia();
      if (downloaded) {
        mediaUrl = await uploadInboundMedia(media, {
          waAccountId,
          waMessageId,
          data: downloaded.data,
          mimeType: downloaded.mimetype,
        });
        mediaMime = downloaded.mimetype;
      } else {
        log.warn({ wa_account_id: waAccountId, wa_message_id: waMessageId }, 'inbound: downloadMedia returned null');
      }
    } catch (err) {
      log.error({ err, wa_account_id: waAccountId, wa_message_id: waMessageId }, 'inbound media upload failed');
    }
  }

  await withTx(async (client) => {
    const inserted = await dedupPgTx(client, waAccountId, waMessageId);
    if (!inserted) {
      log.debug({ wa_account_id: waAccountId, wa_message_id: waMessageId }, 'inbound: pg dedup');
      return;
    }
    const occurredAt = new Date(msg.timestamp * 1_000).toISOString();
    await insertOutboxTx(
      client,
      messageIncoming({
        event_id: newEventId(),
        wa_account_id: waAccountId,
        wa_message_id: waMessageId,
        from: msg.from,
        to: msg.to,
        type: mapType(msg.type),
        body: msg.body,
        ...(mediaUrl !== undefined ? { media_url: mediaUrl } : {}),
        ...(mediaMime !== undefined ? { mime_type: mediaMime } : {}),
        ...(msg._data?.notifyName ? { pushname: msg._data.notifyName } : {}),
        occurred_at: occurredAt,
      }),
    );
  });
  messagesIncomingTotal.inc();
  log.info(
    { wa_account_id: waAccountId, wa_message_id: waMessageId, type: msg.type, from: msg.from, has_media: Boolean(mediaUrl) },
    'inbound queued',
  );
};
