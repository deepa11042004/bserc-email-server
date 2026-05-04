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

## Ready-to-use BSERC registration thank-you template

Use this payload with `POST /api/templates` to create a registration confirmation email template for BSERC:

```json
{
  "templateCode": "bserc_registration_thanks",
  "templateName": "BSERC Registration Thank You",
  "subject": "Thanks for registering with BSERC, {{first_name}}",
  "htmlBody": "<div style=\"margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#1f2937;\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#f4f7fb;padding:24px 12px;\"><tr><td align=\"center\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,0.08);\"><tr><td style=\"background:linear-gradient(135deg,#0f4c81,#1f7a8c);padding:32px 40px;color:#ffffff;\"><div style=\"font-size:12px;letter-spacing:1.6px;text-transform:uppercase;opacity:0.85;\">BSERC</div><h1 style=\"margin:12px 0 0;font-size:28px;line-height:1.3;\">Thanks for registering, {{first_name}}.</h1></td></tr><tr><td style=\"padding:32px 40px 16px;\"><p style=\"margin:0 0 16px;font-size:16px;line-height:1.7;\">We have successfully received your registration for <strong>{{event_name}}</strong>.</p><p style=\"margin:0 0 16px;font-size:16px;line-height:1.7;\">Your interest in BSERC means a lot to us. Our team will review your submission and contact you if any additional details are required.</p><p style=\"margin:0 0 16px;font-size:16px;line-height:1.7;\"><strong>Registration ID:</strong> {{registration_id}}</p><p style=\"margin:0 0 24px;font-size:16px;line-height:1.7;\">Please keep this email for your records. If you have questions, reply to this message or contact us at <a href=\"mailto:{{support_email}}\" style=\"color:#0f4c81;text-decoration:none;\">{{support_email}}</a>.</p><div style=\"margin:24px 0;padding:20px;border-radius:12px;background:#eef6ff;\"><p style=\"margin:0 0 8px;font-size:15px;font-weight:700;\">What happens next</p><p style=\"margin:0;font-size:15px;line-height:1.7;\">You will receive the next update about schedule, screening, or onboarding on your registered email address.</p></div><p style=\"margin:24px 0 0;font-size:16px;line-height:1.7;\">Regards,<br /><strong>BSERC Team</strong></p></td></tr><tr><td style=\"padding:20px 40px 32px;font-size:13px;line-height:1.7;color:#6b7280;\">Sent on {{today_date}}. © {{current_year}} BSERC. All rights reserved.</td></tr></table></td></tr></table></div>",
  "textBody": "Thanks for registering with BSERC, {{first_name}}.\n\nWe have received your registration for {{event_name}}.\nRegistration ID: {{registration_id}}\n\nOur team will review your submission and contact you if any additional details are needed. Please keep this email for your records.\n\nIf you have questions, contact us at {{support_email}}.\n\nRegards,\nBSERC Team"
}
```

Example:

```bash
curl -X POST http://localhost:4000/api/templates \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "templateCode": "bserc_registration_thanks",
  "templateName": "BSERC Registration Thank You",
  "subject": "Thanks for registering with BSERC, {{first_name}}",
  "htmlBody": "<div style=\"margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#1f2937;\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#f4f7fb;padding:24px 12px;\"><tr><td align=\"center\"><table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:640px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,0.08);\"><tr><td style=\"background:linear-gradient(135deg,#0f4c81,#1f7a8c);padding:32px 40px;color:#ffffff;\"><div style=\"font-size:12px;letter-spacing:1.6px;text-transform:uppercase;opacity:0.85;\">BSERC</div><h1 style=\"margin:12px 0 0;font-size:28px;line-height:1.3;\">Thanks for registering, {{first_name}}.</h1></td></tr><tr><td style=\"padding:32px 40px 16px;\"><p style=\"margin:0 0 16px;font-size:16px;line-height:1.7;\">We have successfully received your registration for <strong>{{event_name}}</strong>.</p><p style=\"margin:0 0 16px;font-size:16px;line-height:1.7;\">Your interest in BSERC means a lot to us. Our team will review your submission and contact you if any additional details are required.</p><p style=\"margin:0 0 16px;font-size:16px;line-height:1.7;\"><strong>Registration ID:</strong> {{registration_id}}</p><p style=\"margin:0 0 24px;font-size:16px;line-height:1.7;\">Please keep this email for your records. If you have questions, reply to this message or contact us at <a href=\"mailto:{{support_email}}\" style=\"color:#0f4c81;text-decoration:none;\">{{support_email}}</a>.</p><div style=\"margin:24px 0;padding:20px;border-radius:12px;background:#eef6ff;\"><p style=\"margin:0 0 8px;font-size:15px;font-weight:700;\">What happens next</p><p style=\"margin:0;font-size:15px;line-height:1.7;\">You will receive the next update about schedule, screening, or onboarding on your registered email address.</p></div><p style=\"margin:24px 0 0;font-size:16px;line-height:1.7;\">Regards,<br /><strong>BSERC Team</strong></p></td></tr><tr><td style=\"padding:20px 40px 32px;font-size:13px;line-height:1.7;color:#6b7280;\">Sent on {{today_date}}. © {{current_year}} BSERC. All rights reserved.</td></tr></table></td></tr></table></div>",
  "textBody": "Thanks for registering with BSERC, {{first_name}}.\n\nWe have received your registration for {{event_name}}.\nRegistration ID: {{registration_id}}\n\nOur team will review your submission and contact you if any additional details are needed. Please keep this email for your records.\n\nIf you have questions, contact us at {{support_email}}.\n\nRegards,\nBSERC Team"
}
JSON
```

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
