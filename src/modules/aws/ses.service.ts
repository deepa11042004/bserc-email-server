import { SendEmailCommand } from '@aws-sdk/client-ses';
import { ses } from './clients.js';
import { env } from '../../config/env.js';

export interface SendArgs {
  fromEmail: string;
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  replyTo?: string | null;
  campaignId: number;
  recipientId: number;
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

export const sendOne = async (args: SendArgs): Promise<SendResult> => {
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
  try {
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
