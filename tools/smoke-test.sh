#!/usr/bin/env bash
# End-to-end smoke test against a running docker-compose stack.
# Requires: docker compose up -d, a real test phone, and an env file.
#
# Env vars:
#   API_URL=http://localhost:8080
#   MOCK_BACKEND_URL=http://localhost:9000
#   BACKEND_TO_WA_SHARED_SECRET=...
#   WEBHOOK_SECRET=...                  (must match MOCK_WEBHOOK_SECRET in mock-backend)
#   WORKSPACE_ID=<uuid>
#   TARGET_PHONE=15551234567            (E.164 without +)
set -euo pipefail

API_URL="${API_URL:-http://localhost:8080}"
MOCK_BACKEND_URL="${MOCK_BACKEND_URL:-http://localhost:9000}"
SECRET="${BACKEND_TO_WA_SHARED_SECRET:-replace-me-with-32-bytes-of-random}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-replace-me-with-32-bytes-of-random-aaaa}"
WORKSPACE_ID="${WORKSPACE_ID:-00000000-0000-0000-0000-000000000001}"
TARGET_PHONE="${TARGET_PHONE:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd uuidgen

if [[ -z "$TARGET_PHONE" ]]; then
  echo "set TARGET_PHONE=<E.164 without +>" >&2
  exit 2
fi

echo "==> Waiting for api /ready"
for i in {1..30}; do
  if curl -fsS "$API_URL/ready" >/dev/null 2>&1; then break; fi
  sleep 2
done

ACCOUNT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
echo "==> Creating account $ACCOUNT_ID"
curl -fsS -X POST "$API_URL/accounts" \
  -H "authorization: Bearer $SECRET" \
  -H "content-type: application/json" \
  -d "{\"wa_account_id\":\"$ACCOUNT_ID\",\"workspace_id\":\"$WORKSPACE_ID\",\"webhook_url\":\"http://mock-backend:9000/webhooks\",\"webhook_secret\":\"$WEBHOOK_SECRET\"}" | jq

echo "==> Polling for QR (allocator picks up within ~5s)"
QR=""
for i in {1..40}; do
  RESP="$(curl -fsS -o /tmp/wa_qr -w '%{http_code}' \
    -H "authorization: Bearer $SECRET" "$API_URL/accounts/$ACCOUNT_ID/qr" || true)"
  if [[ "$RESP" == "200" ]]; then
    QR="$(jq -r .qr </tmp/wa_qr)"
    if [[ -n "$QR" && "$QR" != "null" ]]; then break; fi
  fi
  sleep 2
done

if [[ -z "$QR" ]]; then
  echo "no QR — check worker logs (docker compose logs whatsapp-worker)" >&2
  exit 3
fi

echo "==> QR text (paste this into a QR generator or use a phone scanner):"
echo "$QR"
echo ""
echo "==> Open WhatsApp on your test phone, scan the QR. Press ENTER once paired."
read -r

echo "==> Waiting for status=connected"
for i in {1..60}; do
  STATUS="$(curl -fsS -H "authorization: Bearer $SECRET" "$API_URL/accounts/$ACCOUNT_ID" | jq -r .status)"
  if [[ "$STATUS" == "connected" ]]; then break; fi
  sleep 2
done
echo "    status=$STATUS"

if [[ "$STATUS" != "connected" ]]; then
  echo "did not reach connected — exiting" >&2
  exit 4
fi

CMD_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
echo "==> Sending text outbound (command_id=$CMD_ID)"
curl -fsS -X POST "$API_URL/commands" \
  -H "authorization: Bearer $SECRET" \
  -H "content-type: application/json" \
  -d "{\"command_id\":\"$CMD_ID\",\"wa_account_id\":\"$ACCOUNT_ID\",\"to\":\"$TARGET_PHONE\",\"type\":\"text\",\"payload\":{\"body\":\"smoke test from $(hostname) at $(date -u +%H:%M:%SZ)\"}}" | jq

echo "==> Waiting for message.sent_ack at mock-backend"
for i in {1..30}; do
  COUNT="$(curl -fsS "$MOCK_BACKEND_URL/events" | jq '[.events[] | select(.event_type=="message.sent_ack")] | length')"
  if [[ "$COUNT" -gt 0 ]]; then break; fi
  sleep 1
done
echo "    sent_acks=$COUNT"

if [[ "$COUNT" -lt 1 ]]; then
  echo "no sent_ack received — check dispatcher logs" >&2
  exit 5
fi

echo "==> All good. (Inbound test: send a message to your test number from another phone, then GET $MOCK_BACKEND_URL/events.)"
