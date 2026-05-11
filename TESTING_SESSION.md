# WhatsApp Service Testing Session — May 11 2026

## Infrastructure

| Service | URL |
|---------|-----|
| API | https://whatsapp.chaai.online |
| Webhook capture | https://webhook.site/429d4998-d6d8-4b10-8afa-8e78b5036298 |
| VPS | vmi3160834 |

**Shared Secret:** `af089635b8a6fa7d57bddff1fb73071930f6e9bf2703ac0c22471a4e21f6efdf`

---

## Issue 1 — wwebjs v1.26.0 incompatible with WhatsApp QR pairing

### Symptom
QR code rendered correctly but WhatsApp returned **"check your internet connection"** after scanning.

### Root Cause
wwebjs was pinned to `1.26.0`. Latest is `1.34.7`. WhatsApp changed their web protocol and the old version's authentication handshake is rejected by WhatsApp servers.

### Fix
Upgraded `services/worker/package.json`:
```diff
-    "whatsapp-web.js": "1.26.0",
+    "whatsapp-web.js": "1.34.7",
```
Ran `npm install`, committed and pushed → CI/CD rebuilt Docker image.

### Verification
```bash
docker logs whatsapp-whatsapp-worker-1 --tail 20
# Before fix: repeated "qr received" with no "authenticated"
# After fix: same pattern but QR generation was faster
```

---

## Issue 2 — QR pairing silently fails in headless Docker (authenticated event never fires)

### Symptom
User scanned QR on phone, WhatsApp said "linked". Worker logged `qr received` but **`authenticated` and `ready` events never fired**. Account status stuck at `qr_required`.

### Root Cause
Headless Chromium in Docker silently fails to complete the WhatsApp Web authentication handshake after QR scan. The phone-side confirms but the server-side wwebjs client never receives the auth confirmation.

### Curl — create account
```bash
curl -s -X POST https://whatsapp.chaai.online/accounts \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "wa_account_id": "44444444-0000-0000-0000-000000000001",
    "workspace_id": "00000000-0000-0000-0000-000000000001",
    "webhook_url": "https://webhook.site/429d4998-d6d8-4b10-8afa-8e78b5036298",
    "webhook_secret": "test-webhook-secret-32-bytes-xxx!"
  }'
# Response: {"status":"pending"}
```

### Curl — poll for QR
```bash
curl -s https://whatsapp.chaai.online/accounts/44444444-0000-0000-0000-000000000001/qr \
  -H "Authorization: Bearer $SECRET"
# Response: {"qr":"2@wtQAQ...","status":"qr_required"}
```

### Worker log — QR never progresses
```json
{"msg":"qr received","wa_account_id":"44444444-0000-0000-0000-000000000001"}
{"msg":"qr received","wa_account_id":"44444444-0000-0000-0000-000000000001"}
// no "authenticated" or "ready" ever logged
```

### Fix
Implemented `requestPairingCode` (added in wwebjs v1.34) — phone-number based 8-digit code instead of QR. More reliable in headless Docker.

**New endpoint:** `POST /accounts/:id/pairing-code`

**Files changed:**
- `packages/shared/src/redis-keys.ts` — added `pairingPhone`, `pairingCode`, `pairingChannel` keys
- `services/worker/src/managed-session.ts` — call `client.requestPairingCode()` on QR event
- `services/api/src/routes/pairing.ts` — new route (created)
- `services/api/src/app.ts` — registered new route

---

## Issue 3 — Nginx 504 Gateway Timeout on pairing-code endpoint

### Symptom
```html
<html><head><title>504 Gateway Time-out</title></head>...</html>
```

### Root Cause
Nginx `proxy_read_timeout` was 60s. The pairing-code endpoint long-polls for up to 90s.

### Fix
```bash
sed -i 's/proxy_read_timeout 60s/proxy_read_timeout 120s/' \
  /etc/nginx/sites-available/whatsapp.chaai.online
nginx -t && systemctl reload nginx
```

---

## Issue 4 — Race condition: QR fires before pairing-code endpoint sets phone in Redis

### Symptom
```json
{"error":"timeout_waiting_for_code","hint":"Worker may still be initializing — retry in a few seconds"}
```

### Root Cause
Worker fires first QR event ~8s after account creation. The pairing-code API endpoint stores the phone number in Redis. If the endpoint is called AFTER the first QR fires, the phone isn't in Redis when the worker checks, so no code is generated. The endpoint then waits 30s for the NEXT QR cycle but times out before it arrives.

### Fix
Increased poll timeout from 30s → 90s and phone TTL from 120s → 300s.

```diff
-const POLL_TIMEOUT_MS = 30_000;
+const POLL_TIMEOUT_MS = 90_000;

-  pairingPhoneSec: 120,
+  pairingPhoneSec: 300,
```

**Workaround when race condition hits:** Call the endpoint a second time. The phone number is now stored in Redis from the first call, so the next QR cycle will generate the code.

---

## Issue 5 — `requestPairingCode` throws `"t"` (AuthStore not available)

### Symptom
```json
{
  "level": 50,
  "err": {
    "message": "t",
    "stack": "t: t\n    at #evaluate (ExecutionContext.js:391)\n    at Client.requestPairingCode (Client.js:527)"
  },
  "msg": "requestPairingCode failed"
}
```

### Root Cause (initial wrong diagnosis)
Suspected stale `webVersionCache`. Changed to `type: 'remote'` using wppconnect-team's pinned HTML:
```
https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017054665.html
```

This **broke things further** — the wppconnect-team HTML does not expose `window.AuthStore`, so `window.AuthStore.PairingCodeLinkUtils` is always undefined.

### Actual Root Cause
wwebjs v1.34.7 `requestPairingCode` (Client.js:527) requires:
```javascript
window.AuthStore.PairingCodeLinkUtils.setPairingType('ALT_DEVICE_LINKING')
window.AuthStore.PairingCodeLinkUtils.initializeAltDeviceLinking()
window.AuthStore.PairingCodeLinkUtils.startAltLinkingFlow(phoneNumber, showNotification)
```
The wppconnect-team HTML file exposes `window.Store` but NOT `window.AuthStore`. The live WhatsApp web download (`type: 'local'`) correctly exposes both.

**Confirmed:** accounts `33333333` and `44444444` (using `type: 'local'`) had working pairing codes. Accounts `66666666`/`77777777`/`88888888` (using `type: 'remote'`) failed every time.

### Fix
Reverted to `type: 'local'`:
```diff
-      webVersionCache: {
-        type: 'remote',
-        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017054665.html',
-      },
+      webVersionCache: { type: 'local', path: opts.webVersionCachePath },
```

### Status
After revert, pairing codes generate successfully again:
```json
{"code":"LYG5G9GS","msg":"pairing code issued","wa_account_id":"88888888-..."}
{"code":"7KPH6E6W","msg":"pairing code issued","wa_account_id":"88888888-..."}
{"code":"VC6TDSW4","msg":"pairing code issued","wa_account_id":"88888888-..."}
{"code":"VQGF78AX","msg":"pairing code issued","wa_account_id":"88888888-..."}
```

But `requestPairingCode` still fails intermittently after a page re-initialization cycle (happens ~every 3-4 successful codes). The `while (!window.AuthStore.PairingCodeLinkUtils)` loop in wwebjs throws when the page reloads and wwebjs modules haven't re-injected yet.

---

## Issue 6 — CONFLICT disconnect after successful authentication

### Symptom
Account `44444444` connected (phone number stored: `61907675414691`, status briefly `connected`) then immediately went to `banned`.

### Root Cause
Multiple accounts (`33333333` and `44444444`) running simultaneously for the same phone number. WhatsApp detects conflicting web sessions and disconnects both with reason `CONFLICT`. Our `on-disconnected.ts` handler treats `CONFLICT` the same as `BANNED`:

```typescript
const BAN_REASONS = new Set(['LOGOUT', 'CONFLICT', 'BANNED']);
```

### Fix
Delete ALL old accounts before creating a new one. Ensure only one session per phone number is active at any time.

```bash
for ID in 11111111 22222222 33333333 44444444 55555555 66666666 77777777; do
  curl -s -X DELETE "https://whatsapp.chaai.online/accounts/${ID}-0000-0000-0000-000000000001" \
    -H "Authorization: Bearer $SECRET"
done
```

---

## Issue 7 — WhatsApp rate limiting pairing attempts

### Symptom
"Couldn't link device" even when valid codes were generated. Happened after 10+ pairing attempts with the same phone number within ~1 hour.

### Root Cause
WhatsApp rate-limits pairing code attempts per phone number. Generating codes without using them counts against the limit.

### Mitigation
- Wait 5+ minutes between attempts after hitting the limit
- Don't call the pairing-code endpoint multiple times unnecessarily (each call triggers a new code generation on the next QR cycle)

---

## Current State (end of session)

| Account | Status |
|---------|--------|
| `88888888-0000-0000-0000-000000000001` | `qr_required` — active, generating codes |

### Pending test
```bash
# Get a fresh pairing code (after 5min cooldown from rate limit)
curl -s -X POST https://whatsapp.chaai.online/accounts/88888888-0000-0000-0000-000000000001/pairing-code \
  -H "Authorization: Bearer af089635b8a6fa7d57bddff1fb73071930f6e9bf2703ac0c22471a4e21f6efdf" \
  -H "Content-Type: application/json" \
  -d '{"phone_number": "918943657095"}' \
  --max-time 100

# Enter the returned code in:
# WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number
```

### After successful connection, verify with:
```bash
# 1. Check status
curl -s https://whatsapp.chaai.online/accounts/88888888-0000-0000-0000-000000000001 \
  -H "Authorization: Bearer af089635b8a6fa7d57bddff1fb73071930f6e9bf2703ac0c22471a4e21f6efdf" | jq

# 2. Send a test message
curl -s -X POST https://whatsapp.chaai.online/commands \
  -H "Authorization: Bearer af089635b8a6fa7d57bddff1fb73071930f6e9bf2703ac0c22471a4e21f6efdf" \
  -H "Content-Type: application/json" \
  -d '{
    "command_id": "aaaaaaaa-0000-0000-0000-000000000001",
    "wa_account_id": "88888888-0000-0000-0000-000000000001",
    "to": "918943657095",
    "type": "text",
    "payload": {"body": "hello from whatsapp service"}
  }' | jq

# 3. Check webhook.site for message.sent_ack event
# https://webhook.site/429d4998-d6d8-4b10-8afa-8e78b5036298
```

---

## Known Remaining Issues

1. **`requestPairingCode` intermittently fails** after ~every 3-4 successful code cycles. wwebjs modules (`window.AuthStore`) get cleared when the WhatsApp web page re-initializes inside Chromium. The `while (!window.AuthStore.PairingCodeLinkUtils)` loop then throws instead of waiting. Workaround: retry the pairing-code endpoint — it will succeed on the next QR cycle.

2. **CI/CD test job fails** — integration tests require `TEST_DATABASE_URL` and `TEST_REDIS_URL` which aren't set in GitHub Actions. The `deploy` job depends only on `build` (not tests), so deploys succeed regardless.

3. **Deploy path mismatch** — CI/CD deploys to `/var/www/whatsapp` but containers were originally started from `/root/whatsapp`.
