declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type WaAccountId = Brand<string, 'WaAccountId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type EventId = Brand<string, 'EventId'>;
export type WaMessageId = Brand<string, 'WaMessageId'>;
export type WorkerId = Brand<string, 'WorkerId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const assertUuid = (s: string, label: string): void => {
  if (!UUID_RE.test(s)) {
    throw new Error(`invalid ${label}: not a UUID`);
  }
};

export const asWaAccountId = (s: string): WaAccountId => {
  assertUuid(s, 'WaAccountId');
  return s as WaAccountId;
};

export const asWorkspaceId = (s: string): WorkspaceId => {
  assertUuid(s, 'WorkspaceId');
  return s as WorkspaceId;
};

export const asCommandId = (s: string): CommandId => {
  assertUuid(s, 'CommandId');
  return s as CommandId;
};

export const asEventId = (s: string): EventId => {
  assertUuid(s, 'EventId');
  return s as EventId;
};

export const asWaMessageId = (s: string): WaMessageId => s as WaMessageId;

export const asWorkerId = (s: string): WorkerId => {
  if (s.length === 0) throw new Error('invalid WorkerId: empty');
  return s as WorkerId;
};
