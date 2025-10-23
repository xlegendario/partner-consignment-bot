# Render Webhook Probe

Tiny Express app to verify incoming webhooks.  
Endpoints:
- `GET /`       -> health check
- `POST /webhook` -> accepts JSON, logs, and echoes payload
- `GET /inspect`  -> shows the last 25 payloads (HTML)

## Local run
```bash
npm install
npm run dev
# then POST a test:
curl -X POST http://localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
