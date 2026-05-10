import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'api' });
collectDefaultMetrics({ register: registry });

export const commandsReceivedTotal = new Counter({
  name: 'wa_commands_received_total',
  help: 'Outbound commands received by the api',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const accountsCreatedTotal = new Counter({
  name: 'wa_accounts_created_total',
  help: 'Accounts created via POST /accounts',
  registers: [registry],
});

export const leaseTakeoversTotal = new Counter({
  name: 'wa_lease_takeovers_total',
  help: 'Lease assignments performed by the api allocator',
  registers: [registry],
});
