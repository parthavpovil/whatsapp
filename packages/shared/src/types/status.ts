export const ACCOUNT_STATUSES = [
  'pending',
  'qr_required',
  'authenticated',
  'connected',
  'disconnected',
  'banned',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const COMMAND_STATUSES = ['queued', 'sending', 'sent', 'failed'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const EVENT_TYPES = [
  'message.sent_ack',
  'message.delivered',
  'message.read',
  'message.send_failed',
  'message.incoming',
  'session.qr',
  'session.qr_required',
  'session.connected',
  'session.disconnected',
  'session.banned',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const MESSAGE_TYPES = ['text', 'image', 'document', 'audio', 'video'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
