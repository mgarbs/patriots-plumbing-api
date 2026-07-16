# Patriot's Plumbing — API

Backend for the Patriot's Plumbing website: streamed AI service advisor (Claude Sonnet 5),
lead capture with photo upload, and a key-protected dashboard for the plumber.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + free-tier warm-up ping |
| POST | `/api/chat` | SSE stream — virtual service advisor |
| POST | `/api/lead` | Multipart lead submission (fields + up to 6 photos) |
| GET | `/leads?key=…` | Dashboard (newest first, click-to-call, photos, status) |
| GET | `/leads.csv?key=…` | CSV export |

## Environment

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (chat) |
| `DATABASE_URL` | Postgres connection string |
| `ADMIN_KEY` | Dashboard access key |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist (`*` to disable) |
| `NOTIFY_WEBHOOK_URL` | Optional: POSTs a short JSON summary per lead (Slack/Zapier-ready) |

## Run locally

```sh
npm install
ANTHROPIC_API_KEY=... DATABASE_URL=... ADMIN_KEY=dev node server.js
```

Deployed on Render (free web service + free Postgres). Free instances sleep when idle —
the website pings `/api/health` on page load to warm the service.
