import { SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { ses } from './clients.js';
import { env } from '../../config/env.js';

export interface AttachmentData {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendArgs {
  fromEmail: string;
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  replyTo?: string | null;
  campaignId: number;
  recipientId: number;
  attachments?: AttachmentData[];
}

export interface SendResult {
  messageId: string;
}

export class TransientSesError extends Error {
  constructor(message: string, public original: unknown) {
    super(message);
  }
}

const TRANSIENT_CODES = new Set(['Throttling', 'ThrottlingException', 'ServiceUnavailable']);

let mockSendCount = 0;
export const __getMockSendCount = () => mockSendCount;
export const __resetMockSendCount = () => { mockSendCount = 0; };

// ---------------------------------------------------------------------------
// Raw MIME builder — used when attachments are present
// ---------------------------------------------------------------------------
function b64lines(input: string | Buffer): string {
  const b64 = Buffer.isBuffer(input)
    ? input.toString('base64')
    : Buffer.from(input, 'utf8').toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 76) chunks.push(b64.slice(i, i + 76));
  return chunks.join('\r\n');
}

function encodeHeader(val: string): string {
  if (/^[\x20-\x7E]*$/.test(val)) return val;
  return `=?UTF-8?B?${Buffer.from(val, 'utf8').toString('base64')}?=`;
}

function buildRawMime(opts: {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string | null;
  replyTo: string | null;
  configSet?: string;
  attachments: AttachmentData[];
}): Buffer {
  const CRLF = '\r\n';
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  const MIXED = `mixed_${ts}_${rnd}`;
  const ALT = `alt_${ts}_${rnd}`;
  const hasAtts = opts.attachments.length > 0;

  const headerParts = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
    ...(opts.configSet ? [`X-SES-CONFIGURATION-SET: ${opts.configSet}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/${hasAtts ? 'mixed' : 'alternative'}; boundary="${hasAtts ? MIXED : ALT}"`,
    '',
    '',
  ];
  const headers = headerParts.join(CRLF);

  // Build multipart/alternative block (text + html)
  const altBlock = [
    ...(opts.textBody
      ? [
          `--${ALT}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          b64lines(opts.textBody),
          '',
        ]
      : []),
    `--${ALT}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(opts.htmlBody),
    '',
    `--${ALT}--`,
  ].join(CRLF);

  let body = '';
  if (hasAtts) {
    // Wrap alt block in mixed
    body += `--${MIXED}${CRLF}Content-Type: multipart/alternative; boundary="${ALT}"${CRLF}${CRLF}${altBlock}${CRLF}${CRLF}`;
    for (const att of opts.attachments) {
      body += [
        `--${MIXED}`,
        `Content-Type: ${att.contentType}; name="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        b64lines(att.content),
        '',
      ].join(CRLF);
    }
    body += `--${MIXED}--`;
  } else {
    body = altBlock;
  }

  return Buffer.from(headers + body, 'utf8');
}

// ---------------------------------------------------------------------------
// Public send functions
// ---------------------------------------------------------------------------
export const sendOne = async (args: SendArgs): Promise<SendResult> => {
  if (env.TEST_NO_AWS) {
    mockSendCount++;
    return { messageId: `mock-${args.campaignId}-${args.recipientId}-${Date.now()}-${mockSendCount}` };
  }

  const hasAttachments = (args.attachments?.length ?? 0) > 0;

  try {
    if (hasAttachments) {
      const raw = buildRawMime({
        from: args.fromEmail,
        to: args.toEmail,
        subject: args.subject,
        htmlBody: args.htmlBody,
        textBody: args.textBody ?? null,
        replyTo: args.replyTo ?? null,
        configSet: env.SES_CONFIGURATION_SET,
        attachments: args.attachments!,
      });
      const cmd = new SendRawEmailCommand({
        RawMessage: { Data: raw },
        ...(env.SES_CONFIGURATION_SET ? { ConfigurationSetName: env.SES_CONFIGURATION_SET } : {}),
      });
      const out = await ses().send(cmd);
      return { messageId: out.MessageId! };
    }

    const cmd = new SendEmailCommand({
      Source: args.fromEmail,
      Destination: { ToAddresses: [args.toEmail] },
      Message: {
        Subject: { Data: args.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: args.htmlBody, Charset: 'UTF-8' },
          ...(args.textBody ? { Text: { Data: args.textBody, Charset: 'UTF-8' } } : {}),
        },
      },
      ...(args.replyTo ? { ReplyToAddresses: [args.replyTo] } : {}),
      ...(env.SES_CONFIGURATION_SET ? { ConfigurationSetName: env.SES_CONFIGURATION_SET } : {}),
      Tags: [
        { Name: 'campaign_id', Value: String(args.campaignId) },
        { Name: 'recipient_id', Value: String(args.recipientId) },
      ],
    });
    const out = await ses().send(cmd);
    return { messageId: out.MessageId! };
  } catch (e: any) {
    const code = e?.name || e?.Code;
    if (TRANSIENT_CODES.has(code) || e?.$metadata?.httpStatusCode >= 500) {
      throw new TransientSesError(e?.message ?? 'transient SES error', e);
    }
    throw e;
  }
};
