import { Buffer } from 'node:buffer';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { request } from 'undici';
import { log } from './log.js';

export type MediaConfig = {
  s3: S3Client;
  bucket: string;
  allowedHosts: readonly string[];
  maxBytes: number;
  presignedExpiresSec: number;
};

const extFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return mime.slice(6).split(';')[0] ?? 'bin';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return mime.slice(6).split(';')[0] ?? 'bin';
  if (mime.startsWith('video/')) return mime.slice(6).split(';')[0] ?? 'bin';
  return 'bin';
};

// Upload base64 (as wwebjs MessageMedia.data is base64) to S3 and return a
// presigned GET URL with the configured expiry.
export const uploadInboundMedia = async (
  cfg: MediaConfig,
  args: { waAccountId: string; waMessageId: string; data: string; mimeType: string },
): Promise<string> => {
  const buf = Buffer.from(args.data, 'base64');
  const ext = extFromMime(args.mimeType);
  const key = `inbound/${args.waAccountId}/${args.waMessageId}.${ext}`;
  await cfg.s3.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: buf,
      ContentType: args.mimeType,
    }),
  );
  const url = await getSignedUrl(cfg.s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
    expiresIn: cfg.presignedExpiresSec,
  });
  log.debug({ key, bytes: buf.length }, 'inbound media uploaded');
  return url;
};

// Stream a remote URL to a Buffer, capping at maxBytes. Throws on:
//  - host not in allowlist
//  - non-2xx status
//  - body bigger than cap
export const downloadOutboundMedia = async (
  cfg: MediaConfig,
  url: string,
): Promise<{ data: Buffer; mimeType: string }> => {
  const parsed = new URL(url);
  if (cfg.allowedHosts.length > 0 && !cfg.allowedHosts.includes(parsed.hostname)) {
    throw new Error(`outbound media host not allowed: ${parsed.hostname}`);
  }
  const { statusCode, headers, body } = await request(url, {
    method: 'GET',
    headersTimeout: 10_000,
    bodyTimeout: 60_000,
  });
  if (statusCode < 200 || statusCode >= 300) {
    await body.dump();
    throw new Error(`outbound media fetch failed: http_${statusCode}`);
  }
  const mimeType = String(headers['content-type'] ?? 'application/octet-stream').split(';')[0] ?? 'application/octet-stream';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > cfg.maxBytes) {
      throw new Error(`outbound media exceeds cap: ${total} > ${cfg.maxBytes}`);
    }
    chunks.push(buf);
  }
  return { data: Buffer.concat(chunks), mimeType };
};
