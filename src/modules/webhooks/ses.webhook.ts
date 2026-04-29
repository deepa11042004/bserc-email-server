import type { Request, Response } from 'express';
import { Router, json } from 'express';
import { logger } from '../../common/logger.js';
import { appPool } from '../../db/pools.js';

export const webhookRouter = Router();

// Use raw text parser specifically for this route — SNS sends application/json
// but with header `x-amz-sns-message-type`. We parse manually.
webhookRouter.use(json({ limit: '2mb', type: ['application/json', 'text/plain'] }));

interface SnsEnvelope {
  Type: string;
  MessageId?: string;
  Token?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  SubscribeURL?: string;
  Timestamp?: string;
}

interface SesNotification {
  eventType?: string; // configuration set events use eventType
  notificationType?: string; // legacy bounce/complaint use notificationType
  mail?: {
    messageId?: string;
    destination?: string[];
    timestamp?: string;
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[];
    timestamp?: string;
  };
  complaint?: {
    complainedRecipients?: { emailAddress: string }[];
    complaintFeedbackType?: string;
    timestamp?: string;
  };
  delivery?: {
    timestamp?: string;
    recipients?: string[];
  };
}

const parseEnvelope = (body: unknown): SnsEnvelope | null => {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (body && typeof body === 'object') return body as SnsEnvelope;
  return null;
};

const eventTypeMap: Record<string, string> = {
  Send: 'Send',
  Delivery: 'Delivery',
  Bounce: 'Bounce',
  Complaint: 'Complaint',
  Reject: 'Reject',
  Open: 'Open',
  Click: 'Click',
  RenderingFailure: 'RenderingFailure',
  DeliveryDelay: 'DeliveryDelay',
  Subscription: 'Subscription',
};

async function findRecipientByMessageId(messageId: string) {
  const [rows]: any = await appPool().query(
    'SELECT id, campaign_id, email FROM campaign_recipients WHERE ses_message_id = ? LIMIT 1',
    [messageId]
  );
  return rows[0] as { id: number; campaign_id: number; email: string } | undefined;
}

async function recordEvent(args: {
  campaignId: number | null;
  recipientId: number | null;
  email: string | null;
  eventType: string;
  messageId: string | null;
  payload: unknown;
}) {
  const ev = eventTypeMap[args.eventType] || 'Unknown';
  await appPool().query(
    `INSERT INTO email_events (campaign_id, recipient_id, event_type, provider_message_id, email, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      args.campaignId,
      args.recipientId,
      ev,
      args.messageId,
      args.email,
      JSON.stringify(args.payload),
    ]
  );
}

async function addToSuppressionList(email: string, reason: 'BOUNCE' | 'COMPLAINT', notes?: string) {
  await appPool().query(
    `INSERT INTO suppression_list (email, reason, notes) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), notes = VALUES(notes)`,
    [email.toLowerCase(), reason, notes ?? null]
  );
}

async function handleSesEvent(payload: SesNotification) {
  const eventType = payload.eventType || payload.notificationType || 'Unknown';
  const messageId = payload.mail?.messageId || null;
  const recipient = messageId ? await findRecipientByMessageId(messageId) : undefined;
  const campaignId = recipient?.campaign_id ?? null;

  if (eventType === 'Bounce' && payload.bounce) {
    const isPermanent = payload.bounce.bounceType === 'Permanent';
    const bouncees = payload.bounce.bouncedRecipients || [];
    for (const b of bouncees) {
      await recordEvent({
        campaignId,
        recipientId: recipient?.id ?? null,
        email: b.emailAddress,
        eventType: 'Bounce',
        messageId,
        payload,
      });
      if (isPermanent) {
        await addToSuppressionList(b.emailAddress, 'BOUNCE', b.diagnosticCode);
      }
      if (recipient && b.emailAddress.toLowerCase() === recipient.email.toLowerCase()) {
        await appPool().query(
          `UPDATE campaign_recipients SET status='BOUNCED', error_reason=? WHERE id=?`,
          [(b.diagnosticCode || 'bounce').slice(0, 1000), recipient.id]
        );
        await appPool().query(
          'UPDATE campaigns SET bounced_count = bounced_count + 1 WHERE id = ?',
          [recipient.campaign_id]
        );
      }
    }
    return;
  }

  if (eventType === 'Complaint' && payload.complaint) {
    const complainers = payload.complaint.complainedRecipients || [];
    for (const c of complainers) {
      await recordEvent({
        campaignId,
        recipientId: recipient?.id ?? null,
        email: c.emailAddress,
        eventType: 'Complaint',
        messageId,
        payload,
      });
      await addToSuppressionList(c.emailAddress, 'COMPLAINT', payload.complaint.complaintFeedbackType);
      if (recipient && c.emailAddress.toLowerCase() === recipient.email.toLowerCase()) {
        await appPool().query(
          `UPDATE campaign_recipients SET status='COMPLAINT' WHERE id=?`,
          [recipient.id]
        );
        await appPool().query(
          'UPDATE campaigns SET complaint_count = complaint_count + 1 WHERE id = ?',
          [recipient.campaign_id]
        );
      }
    }
    return;
  }

  if (eventType === 'Delivery' && payload.delivery) {
    await recordEvent({
      campaignId,
      recipientId: recipient?.id ?? null,
      email: payload.delivery.recipients?.[0] || recipient?.email || null,
      eventType: 'Delivery',
      messageId,
      payload,
    });
    if (recipient) {
      await appPool().query(
        `UPDATE campaign_recipients SET status='DELIVERED', delivered_at=NOW() WHERE id=?`,
        [recipient.id]
      );
      await appPool().query(
        'UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = ?',
        [recipient.campaign_id]
      );
    }
    return;
  }

  // Generic: just record the event
  await recordEvent({
    campaignId,
    recipientId: recipient?.id ?? null,
    email: payload.mail?.destination?.[0] ?? null,
    eventType,
    messageId,
    payload,
  });
}

webhookRouter.post('/', async (req: Request, res: Response) => {
  try {
    const env = parseEnvelope(req.body);
    if (!env) {
      logger.warn('Webhook received unparseable payload');
      return res.status(400).end();
    }

    if (env.Type === 'SubscriptionConfirmation' && env.SubscribeURL) {
      // Auto-confirm SNS subscriptions
      try {
        const r = await fetch(env.SubscribeURL);
        logger.info({ status: r.status }, 'Confirmed SNS subscription');
      } catch (e) {
        logger.error({ err: e }, 'Failed to confirm SNS subscription');
      }
      return res.status(200).end();
    }

    if (env.Type === 'Notification') {
      let payload: SesNotification = {};
      try {
        payload = env.Message ? JSON.parse(env.Message) : {};
      } catch (e) {
        logger.warn({ err: e }, 'Failed to parse SNS Message body');
      }
      await handleSesEvent(payload);
      return res.status(200).end();
    }

    // UnsubscribeConfirmation or unknown
    logger.info({ type: env.Type }, 'Received SNS envelope');
    return res.status(200).end();
  } catch (e) {
    logger.error({ err: e }, 'Webhook handler failed');
    return res.status(500).end();
  }
});
