# Troubleshooting

## Migrations / DB

### `Access denied for user 'admin'@'…'`
Either the password in `.env` is wrong, or your machine's public IP is not in the RDS security group's inbound rule for port 3306. Add the IP and retry.

### `ER_BAD_DB_ERROR: Unknown database 'email_notification_db'`
Run `npm run migrate`. The migrate script creates the database if it does not exist.

### Migrations partially applied / odd state
`schema_migrations` tracks applied migration ids. To replay one, delete that row and re-run `npm run migrate`.

## API

### 401 Unauthorized on every protected route
You forgot the `Authorization: Bearer <token>` header. Hit `POST /api/auth/login` first; the response contains `token`.

### 403 Forbidden
The endpoint requires a higher role. `VIEWER` cannot mutate. `OPERATOR` cannot delete templates, run raw queries, or cancel campaigns. `ADMIN` only.

### 400 with `details: { fieldErrors: ... }`
Zod rejected the request body. Each field error lists what is wrong.

## Campaigns / Worker

### Campaign stuck at `RUNNING`, sent_count not increasing
1. Worker not running — check `npm run dev:worker` output.
2. `SQS_QUEUE_URL` empty — re-run `npm run infra:setup`.
3. SES sandbox — only verified destinations get delivered; non-verified causes `MessageRejected`.

### `recipients/s` slower than expected
- `WORKER_CONCURRENCY` is the parallelism per worker process. Run more replicas (`docker-compose up --scale worker=N`).
- `SES_MAX_SEND_RATE_PER_SEC` caps throughput — check your SES account's actual quota and bump.
- DB pool size (`connectionLimit: 15`) — bump if you run > 15 concurrent workers per process.

### Campaign 5xx during create
Check the API process logs (pino-pretty in dev). The most common cause is a placeholder/template/from-email mismatch.

## Webhooks

### SNS subscription stuck at "PendingConfirmation"
- Webhook URL must be reachable from the public internet over HTTPS.
- The handler auto-confirms by hitting the `SubscribeURL`. If it failed you'll see `Failed to confirm SNS subscription` in logs — usually DNS or firewall.

### Bounce doesn't add to suppression
Only **permanent** bounces are added (transient bounces should not be suppressed). Complaint events always add.

### Events not arriving
`SES_CONFIGURATION_SET` must be set on outbound mail (we set it automatically when the env var is non-empty). Without it, SES will not publish events to SNS.

## Local development

### `EADDRINUSE: address already in use :::4000`
Another process is on port 4000. `lsof -nP -iTCP:4000 -sTCP:LISTEN` to find it.

### `tsx watch` not reloading
Sometimes the watcher needs a clean restart. `pkill -f "tsx watch"` then `npm run dev`.

## Tests

### `Cannot find module 'dotenv/config'` (or other missing dep) in tests
Re-run `npm install`.

### Tests pollute the production DB
The integration tests write to your actual `email_notification_db`. They prefix all rows with `TEST_RUN`, `test_`, `TEST_`, `*-test@bserc.local`, or `*@example.test`, and clean up at the start of each suite. To run them against a sandbox DB, override `APP_DB_NAME` before invoking `npm test`.

## SES

### Most production rollouts fail because of one of these
- Domain not verified, or DKIM CNAMEs not added.
- Account still in sandbox.
- DMARC mis-set (`p=reject` from a domain whose subdomains never DKIM-sign).
- Sender reputation tanked because previous bulk send had no suppression list.

The code handles the mechanics. Deliverability is operational hygiene.
