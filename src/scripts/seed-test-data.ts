/**
 * Seeds 10 templates, 5 campaigns, 500 recipients distributed across them.
 * Idempotent: rows tagged 'demo_' / 'DEMO_' are deleted at the start.
 */
import { appPool, closeAllPools } from '../db/pools.js';
import { logger } from '../common/logger.js';

const TEMPLATES = [
  { code: 'demo_welcome', name: 'Welcome', subject: 'Welcome {{first_name}}!', html: '<p>Hi {{first_name}}, welcome to {{company_name}}.</p>' },
  { code: 'demo_invite', name: 'Job Invite', subject: 'Interview at {{company_name}}', html: '<p>Hi {{first_name}}, we would love to interview you.</p>' },
  { code: 'demo_reminder', name: 'Reminder', subject: 'Reminder: {{event_name}}', html: '<p>Hi {{first_name}}, just a reminder about {{event_name}}.</p>' },
  { code: 'demo_offer', name: 'Special Offer', subject: 'A special offer for {{first_name}}', html: '<p>Hi {{first_name}}, here is a special offer.</p>' },
  { code: 'demo_newsletter', name: 'Monthly Newsletter', subject: '{{company_name}} Newsletter — {{today_date}}', html: '<p>Hi {{first_name}}, here is what is new.</p>' },
  { code: 'demo_password_reset', name: 'Password Reset', subject: 'Reset your password', html: '<p>Click the link.</p>' },
  { code: 'demo_followup', name: 'Follow-up', subject: 'Following up, {{first_name}}', html: '<p>Just following up.</p>' },
  { code: 'demo_thank_you', name: 'Thank You', subject: 'Thank you, {{first_name}}', html: '<p>Thanks for your interest!</p>' },
  { code: 'demo_renewal', name: 'Renewal', subject: 'Time to renew', html: '<p>Hi {{first_name}}, your plan is up for renewal.</p>' },
  { code: 'demo_feedback', name: 'Feedback', subject: 'How was your experience, {{first_name}}?', html: '<p>Please share your feedback.</p>' },
];

const CAMPAIGNS = [
  { name: 'DEMO_Hiring_Drive_2026', tplCode: 'demo_invite', count: 200 },
  { name: 'DEMO_Newsletter_April', tplCode: 'demo_newsletter', count: 100 },
  { name: 'DEMO_Reactivation', tplCode: 'demo_offer', count: 80 },
  { name: 'DEMO_Followup_Wave', tplCode: 'demo_followup', count: 80 },
  { name: 'DEMO_Feedback_Survey', tplCode: 'demo_feedback', count: 40 },
];

async function clear() {
  const pool = appPool();
  await pool.query(`DELETE FROM campaign_recipients WHERE campaign_id IN (SELECT id FROM campaigns WHERE campaign_name LIKE 'DEMO_%')`);
  await pool.query(`DELETE FROM campaigns WHERE campaign_name LIKE 'DEMO_%'`);
  await pool.query(`DELETE FROM email_templates WHERE template_code LIKE 'demo_%'`);
}

async function seedTemplates() {
  const pool = appPool();
  const ids: Record<string, number> = {};
  for (const t of TEMPLATES) {
    const [r]: any = await pool.query(
      `INSERT INTO email_templates (template_code, template_name, subject, html_body, status)
       VALUES (?, ?, ?, ?, 'ACTIVE')`,
      [t.code, t.name, t.subject, t.html]
    );
    ids[t.code] = r.insertId;
  }
  return ids;
}

async function seedCampaigns(tplIds: Record<string, number>) {
  const pool = appPool();
  let totalRecipients = 0;
  for (const c of CAMPAIGNS) {
    const tplId = tplIds[c.tplCode];
    if (!tplId) throw new Error(`Missing template ${c.tplCode}`);
    const [r]: any = await pool.query(
      `INSERT INTO campaigns (campaign_name, template_id, from_email, source_type, source_meta, global_vars, status, total_recipients)
       VALUES (?, ?, 'demo@bserc.local', 'API', JSON_OBJECT('seed', true), JSON_OBJECT('company_name', 'BSERC Demo'), 'COMPLETED', ?)`,
      [c.name, tplId, c.count]
    );
    const campaignId = r.insertId as number;

    const rows = Array.from({ length: c.count }).map((_, i) => [
      campaignId,
      `demo_${c.name.toLowerCase()}_${i}@example.test`,
      `First${i}`,
      `Last${i}`,
      JSON.stringify({ event_name: 'Demo Event', segment: i % 3 === 0 ? 'A' : 'B' }),
      i % 7 === 0 ? 'FAILED' : 'SENT',
      i % 7 === 0 ? null : `mock-demo-${campaignId}-${i}`,
    ]);
    const sql = `INSERT INTO campaign_recipients
      (campaign_id, email, first_name, last_name, payload_json, status, ses_message_id, sent_at)
      VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, NOW())').join(',')}`;
    const params = rows.flat();
    await pool.query(sql, params);

    const sent = c.count - Math.floor(c.count / 7) - 1;
    const failed = c.count - sent;
    await pool.query(
      `UPDATE campaigns SET sent_count = ?, failed_count = ?, queued_count = total_recipients,
                            started_at = NOW(), completed_at = NOW() WHERE id = ?`,
      [sent, failed, campaignId]
    );
    totalRecipients += c.count;
  }
  return totalRecipients;
}

async function main() {
  await clear();
  const tplIds = await seedTemplates();
  const totalRecipients = await seedCampaigns(tplIds);
  logger.info({ templates: Object.keys(tplIds).length, campaigns: CAMPAIGNS.length, recipients: totalRecipients }, 'Seed complete');
}

main()
  .catch((e) => {
    logger.error({ err: e }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(closeAllPools);
