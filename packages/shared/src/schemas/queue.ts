import { z } from 'zod';
import { OutboundCommandSchema } from './command.js';

// What the api LPUSHes onto queue:worker:{worker_id}.
// Carries the validated command plus the resolved worker assignment timestamp,
// so the worker can stale-detect if a queue item arrives long after enqueue.
export const QueueMessageSchema = z.object({
  enqueued_at: z.string(), // iso8601
  command: OutboundCommandSchema,
});
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
