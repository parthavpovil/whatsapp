import type { FastifyReply, FastifyRequest } from 'fastify';

export const makeBearerAuth =
  (sharedSecret: string) =>
  async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const provided = header.slice('Bearer '.length);
    // Constant-time-ish: avoid early-exit comparison.
    if (provided.length !== sharedSecret.length) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    let mismatch = 0;
    for (let i = 0; i < provided.length; i++) {
      mismatch |= provided.charCodeAt(i) ^ sharedSecret.charCodeAt(i);
    }
    if (mismatch !== 0) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
  };
