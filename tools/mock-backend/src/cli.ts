import { uuidv7 } from '@wa/shared';
// Tiny CLI: send a command to the api directly.
// Usage:
//   tsx tools/mock-backend/src/cli.ts \
//     --api http://localhost:8080 \
//     --secret <BACKEND_TO_WA_SHARED_SECRET> \
//     --account <wa_account_id> \
//     --to 5551234567 \
//     --body "hello"
import { request } from 'undici';

const args = (() => {
  const out: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[a.slice(2)] = 'true';
        continue;
      }
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
})();

const api = args.api ?? 'http://localhost:8080';
const secret = args.secret ?? process.env.BACKEND_TO_WA_SHARED_SECRET ?? '';
const account = args.account;
const to = args.to;
const body = args.body ?? 'hello from mock-backend';

if (!secret || !account || !to) {
  console.error(
    'usage: cli --account <id> --to <phone> [--body <text>] [--api <url>] [--secret <token>]',
  );
  process.exit(2);
}

const main = async (): Promise<void> => {
  const command_id = uuidv7();
  const cmdBody = JSON.stringify({
    command_id,
    wa_account_id: account,
    to,
    type: 'text',
    payload: { body },
  });
  const { statusCode, body: respBody } = await request(`${api}/commands`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: cmdBody,
  });
  const text = await respBody.text();
  console.log(`HTTP ${statusCode}`);
  console.log(text);
  if (statusCode >= 400) process.exit(1);
};

void main().catch((err) => {
  console.error('cli error:', err);
  process.exit(1);
});
