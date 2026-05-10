import { newEventId, messageDelivered, messageRead } from '@wa/shared';
import { log } from '../log.js';
import { insertOutbox } from '../outbox.js';

// wwebjs MessageAck levels:
// -1=ERROR, 0=PENDING, 1=SENT, 2=RECEIVED, 3=READ, 4=PLAYED
//
// We map RECEIVED -> message.delivered, READ -> message.read.
// SENT is reflected in the synchronous send-path UPDATE, not here.
export const onMessageAck = async (
  waAccountId: string,
  waMessageId: string,
  to: string,
  ackLevel: number,
): Promise<void> => {
  const at = new Date().toISOString();
  if (ackLevel === 2) {
    await insertOutbox(
      messageDelivered({ event_id: newEventId(), wa_account_id: waAccountId, wa_message_id: waMessageId, to, at }),
    );
    return;
  }
  if (ackLevel === 3 || ackLevel === 4) {
    await insertOutbox(
      messageRead({ event_id: newEventId(), wa_account_id: waAccountId, wa_message_id: waMessageId, to, at }),
    );
    return;
  }
  log.debug({ ackLevel, waMessageId }, 'message_ack: ignoring level');
};
