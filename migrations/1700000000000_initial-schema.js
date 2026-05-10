/* eslint-disable @typescript-eslint/naming-convention */
exports.up = (pgm) => {
  // wa_accounts: one row per connected WhatsApp number
  pgm.createTable('wa_accounts', {
    id: { type: 'uuid', primaryKey: true },
    workspace_id: { type: 'uuid', notNull: true },
    phone_number: { type: 'text' },
    status: { type: 'text', notNull: true },
    webhook_url: { type: 'text', notNull: true },
    webhook_secret: { type: 'text', notNull: true },
    worker_id: { type: 'text' },
    lease_expires_at: { type: 'timestamptz' },
    last_qr: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('wa_accounts', 'wa_accounts_status_check', {
    check: "status IN ('pending','qr_required','authenticated','connected','disconnected','banned')",
  });
  pgm.createIndex('wa_accounts', 'worker_id', {
    name: 'wa_accounts_worker_id_idx',
    where: 'worker_id IS NOT NULL',
  });
  pgm.createIndex('wa_accounts', 'lease_expires_at', {
    name: 'wa_accounts_lease_expires_at_idx',
    where: 'worker_id IS NOT NULL',
  });

  // wa_session_blobs: wwebjs RemoteAuth state (gzipped tar)
  pgm.createTable('wa_session_blobs', {
    wa_account_id: {
      type: 'uuid',
      primaryKey: true,
      references: '"wa_accounts"',
      onDelete: 'CASCADE',
    },
    blob: { type: 'bytea', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // outbound_commands: idempotency for outbound commands
  pgm.createTable('outbound_commands', {
    command_id: { type: 'uuid', primaryKey: true },
    wa_account_id: {
      type: 'uuid',
      notNull: true,
      references: '"wa_accounts"',
    },
    payload: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true },
    wa_message_id: { type: 'text' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('outbound_commands', 'outbound_commands_status_check', {
    check: "status IN ('queued','sending','sent','failed')",
  });
  pgm.createIndex('outbound_commands', ['wa_account_id', 'status']);

  // events_outbox: transactional outbox for backend webhooks
  pgm.createTable('events_outbox', {
    event_id: { type: 'uuid', primaryKey: true },
    wa_account_id: {
      type: 'uuid',
      notNull: true,
      references: '"wa_accounts"',
    },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    attempts: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    delivered_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('events_outbox', 'next_attempt_at', {
    name: 'events_outbox_pending_idx',
    where: 'delivered_at IS NULL',
  });

  // seen_wa_messages: inbound dedup
  pgm.createTable('seen_wa_messages', {
    wa_account_id: { type: 'uuid', notNull: true },
    wa_message_id: { type: 'text', notNull: true },
    seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('seen_wa_messages', 'seen_wa_messages_pkey', {
    primaryKey: ['wa_account_id', 'wa_message_id'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('seen_wa_messages');
  pgm.dropTable('events_outbox');
  pgm.dropTable('outbound_commands');
  pgm.dropTable('wa_session_blobs');
  pgm.dropTable('wa_accounts');
};
