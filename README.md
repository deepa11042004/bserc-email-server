# BSERC Email Notification Server

Bulk email platform: AWS SES + SQS + SNS, MySQL, Node.js (TypeScript).

Two processes:
- **API** (`src/server.ts`) — REST API for templates, campaigns, suppression, webhooks.
- **Worker** (`src/worker.ts`) — pulls jobs from SQS, renders, sends via SES, retries transient failures.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in real values

# 1. Create DB schema in EMAIL_NOTIFICATION_DB
npm run migrate

# 2. Seed an admin user (override with env if you want)
ADMIN_EMAIL=admin@bserc.local ADMIN_PASSWORD='ChangeMe!2026' npm run seed:admin

# 3. Bootstrap AWS infra (SQS + DLQ + SNS topic + SES configuration set)
npm run infra:setup
# Copy the printed SQS_QUEUE_URL / SQS_DLQ_URL / SNS_TOPIC_ARN back into .env

# 4. Run
npm run dev          # API on :4000
npm run dev:worker   # in another terminal
```

Login:

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@bserc.local","password":"ChangeMe!2026"}'
```

## Architecture

```
CRM / Web                  ┌──────────────────┐
   │                       │   Email API      │
   ├── REST ──────────────▶│  (Express)       │
                           └────────┬─────────┘
                                    │ writes campaign + recipients
                                    ▼
                           ┌──────────────────┐
                           │  MySQL           │
                           │  email_notif_db  │
                           └────────┬─────────┘
                                    │ enqueue {campaignId, recipientId}
                                    ▼
                           ┌──────────────────┐
                           │  Amazon SQS      │──── DLQ (after 6 retries)
                           └────────┬─────────┘
                                    │ pull
                                    ▼
                           ┌──────────────────┐
                           │  Worker          │
                           │  (rate-limited)  │
                           └────────┬─────────┘
                                    │ SendEmail
                                    ▼
                           ┌──────────────────┐
                           │  Amazon SES      │
                           └────────┬─────────┘
                                    │ delivery / bounce / complaint
                                    ▼
                           ┌──────────────────┐
                           │  SNS topic       │
                           └────────┬─────────┘
                                    │ HTTPS POST
                                    ▼
                           ┌──────────────────┐
                           │  /api/webhooks/  │
                           │  ses             │
                           └──────────────────┘
```

## Recipient sourcing

Three modes — same campaign engine, different ingestion:

1. **API** — `POST /api/campaigns/send` with a `recipients` array.
2. **DB table** — `POST /api/campaigns/send-from-db`. Table must be in `ALLOWED_RECIPIENT_TABLES`. Identifiers and `whereClause` are validated.
3. **Raw query** — `POST /api/campaigns/send-from-query`. Disabled by default. Set `ALLOW_RAW_QUERY=true` to enable. Only `SELECT` is allowed; multi-statement, DDL keywords, and `INTO OUTFILE` are blocked.

## API surface

```
POST   /api/auth/login
GET    /api/auth/me                  (requires bearer)

GET    /api/templates
POST   /api/templates
GET    /api/templates/:id
PUT    /api/templates/:id
DELETE /api/templates/:id            (admin only)
POST   /api/templates/:id/preview

POST   /api/campaigns/send
POST   /api/campaigns/send-from-db
POST   /api/campaigns/send-from-query  (admin only)
GET    /api/campaigns
GET    /api/campaigns/:id
GET    /api/campaigns/:id/stats
GET    /api/campaigns/:id/recipients
POST   /api/campaigns/:id/pause
POST   /api/campaigns/:id/resume
POST   /api/campaigns/:id/cancel       (admin only)
POST   /api/campaigns/test-send

GET    /api/suppression
POST   /api/suppression
DELETE /api/suppression/:email         (admin only)

POST   /api/webhooks/ses             (public — SNS subscription)

GET    /health
```

## Placeholders

`{{first_name}} {{last_name}} {{full_name}} {{email}} {{today_date}} {{current_year}}` — plus anything in the recipient `data` payload or campaign `globalVars`. Unknown placeholders render as empty string.

## Pause / resume / cancel

- **Pause** — worker leaves the in-flight message in SQS (visibility expires, message returns later).
- **Resume** — flip status back to `RUNNING`; existing queued messages just get processed.
- **Cancel** — terminal. Worker drops messages for the campaign on receive.

## Deliverability

The code handles the mechanics. You still need:
- Verified sending domain in SES with **SPF**, **DKIM**, **DMARC** set.
- A warmed-up reputation (don't blast 50k from a cold domain).
- Production access on SES (out of sandbox).
- Tune `SES_MAX_SEND_RATE_PER_SEC` to your account's send-rate quota.

## Rotating the AWS keys

The keys you provided are in `.env` (gitignored). Rotate them in the AWS console and update `.env` — the application reads them lazily, restart processes after the change.
