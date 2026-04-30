import './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { closeAllPools, appPool } from '../src/db/pools.js';
import { ensureUser, tokenForUser, TEST_ADMIN } from './helpers.js';

const app = buildApp();
let adminToken: string;
let templateId: number;
let campaignId: number;
let recipientId: number;
const messageId = `webhook-msg-${Date.now()}`;

before(async () => {
  await ensureUser(TEST_ADMIN);
  adminToken = await tokenForUser(TEST_ADMIN.email);
  await appPool().query(`DELETE FROM email_templates WHERE template_code = 'test_webhook'`);
  await appPool().query(`DELETE FROM suppression_list WHERE email LIKE '%@example.test'`);

  const t = await request(app)
    .post('/api/templates')
    .set('authorization', `Bearer ${adminToken}`)
    .send({ templateCode: 'test_webhook', templateName: 'Webhook', subject: 'X', htmlBody: '<p>x</p>' });
  templateId = t.body.id;

  const c = await request(app)
    .post('/api/campaigns/send')
    .set('authorization', `Bearer ${adminToken}`)
    .send({
      campaignName: 'TEST_WEBHOOK',
      templateId,
      fromEmail: 'test@example.test',
      recipients: [
        { email: 'bounce@example.test' },
        { email: 'complaint@example.test' },
        { email: 'delivery@example.test' },
      ],
    });
  campaignId = c.body.campaignId;
  // Map the first recipient to the messageId we will use in webhook payloads
  const [recips]: any = await appPool().query(
    `SELECT id, email FROM campaign_recipients WHERE campaign_id = ? ORDER BY id ASC`,
    [campaignId]
  );
  // Assign known message IDs
  for (const r of recips) {
    await appPool().query(
      `UPDATE campaign_recipients SET status='SENT', ses_message_id=? WHERE id=?`,
      [`${messageId}-${r.email}`, r.id]
    );
  }
  recipientId = recips[0].id;
});

after(async () => { await closeAllPools(); });

test('webhook auto-confirms SubscriptionConfirmation', async () => {
  // We can't easily mock fetch here; this test just verifies the response code is 200.
  const r = await request(app).post('/api/webhooks/ses').send({
    Type: 'SubscriptionConfirmation',
    SubscribeURL: 'https://example.invalid/confirm',
  });
  assert.equal(r.status, 200);
});

test('webhook handles Bounce notification (permanent) -> suppression list', async () => {
  const inner = {
    eventType: 'Bounce',
    mail: { messageId: `${messageId}-bounce@example.test`, destination: ['bounce@example.test'] },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: 'bounce@example.test', diagnosticCode: 'mailbox does not exist' }],
    },
  };
  const r = await request(app).post('/api/webhooks/ses').send({
    Type: 'Notification',
    Message: JSON.stringify(inner),
  });
  assert.equal(r.status, 200);

  const [sup]: any = await appPool().query('SELECT * FROM suppression_list WHERE email = ?', [
    'bounce@example.test',
  ]);
  assert.equal(sup.length, 1);
  assert.equal(sup[0].reason, 'BOUNCE');

  const [rec]: any = await appPool().query(
    'SELECT status FROM campaign_recipients WHERE ses_message_id = ?',
    [`${messageId}-bounce@example.test`]
  );
  assert.equal(rec[0].status, 'BOUNCED');
});

test('webhook handles Complaint notification -> suppression list', async () => {
  const inner = {
    eventType: 'Complaint',
    mail: { messageId: `${messageId}-complaint@example.test`, destination: ['complaint@example.test'] },
    complaint: {
      complainedRecipients: [{ emailAddress: 'complaint@example.test' }],
      complaintFeedbackType: 'abuse',
    },
  };
  const r = await request(app).post('/api/webhooks/ses').send({
    Type: 'Notification',
    Message: JSON.stringify(inner),
  });
  assert.equal(r.status, 200);

  const [sup]: any = await appPool().query('SELECT * FROM suppression_list WHERE email = ?', [
    'complaint@example.test',
  ]);
  assert.equal(sup[0].reason, 'COMPLAINT');

  const [rec]: any = await appPool().query(
    'SELECT status FROM campaign_recipients WHERE ses_message_id = ?',
    [`${messageId}-complaint@example.test`]
  );
  assert.equal(rec[0].status, 'COMPLAINT');
});

test('webhook handles Delivery notification', async () => {
  const inner = {
    eventType: 'Delivery',
    mail: { messageId: `${messageId}-delivery@example.test`, destination: ['delivery@example.test'] },
    delivery: { recipients: ['delivery@example.test'], timestamp: new Date().toISOString() },
  };
  const r = await request(app).post('/api/webhooks/ses').send({
    Type: 'Notification',
    Message: JSON.stringify(inner),
  });
  assert.equal(r.status, 200);

  const [rec]: any = await appPool().query(
    'SELECT status, delivered_at FROM campaign_recipients WHERE ses_message_id = ?',
    [`${messageId}-delivery@example.test`]
  );
  assert.equal(rec[0].status, 'DELIVERED');
  assert.ok(rec[0].delivered_at);

  const [events]: any = await appPool().query(
    `SELECT event_type FROM email_events WHERE provider_message_id = ?`,
    [`${messageId}-delivery@example.test`]
  );
  assert.ok(events.some((e: any) => e.event_type === 'Delivery'));
});

test('campaign stats reflect bounce/complaint/delivery counters', async () => {
  const stats = await request(app).get(`/api/campaigns/${campaignId}/stats`)
    .set('authorization', `Bearer ${adminToken}`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.counters.bounced, 1);
  assert.equal(stats.body.counters.complaints, 1);
  assert.equal(stats.body.counters.delivered, 1);
});
