import { createHmac, timingSafeEqual } from 'node:crypto';

const ALGO = 'sha256';
const PREFIX = 'sha256=';

export const sign = (body: string | Buffer, secret: string): string => {
  const mac = createHmac(ALGO, secret).update(body).digest('hex');
  return `${PREFIX}${mac}`;
};

export const verify = (body: string | Buffer, header: string, secret: string): boolean => {
  if (!header.startsWith(PREFIX)) return false;
  const provided = header.slice(PREFIX.length);
  const expected = createHmac(ALGO, secret).update(body).digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
};
