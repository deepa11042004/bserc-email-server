import { env } from '../config/env.js';

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' }, details: {} },
};

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'BSERC Email Notification API',
    version: '1.0.0',
    description:
      'Bulk email platform on top of AWS SES + SQS + SNS. Templates, campaigns from API/DB/SQL sources, worker-based delivery, bounce/complaint webhooks, suppression list.',
  },
  servers: [{ url: `http://localhost:${env.PORT}`, description: 'local' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: errorSchema,
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'admin@bserc.local' },
          password: { type: 'string', example: 'ChangeMe!2026' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'JWT bearer token' },
          user: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              email: { type: 'string' },
              name: { type: 'string', nullable: true },
              role: { type: 'string', enum: ['ADMIN', 'OPERATOR', 'VIEWER'] },
            },
          },
        },
      },
      Template: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          template_code: { type: 'string' },
          template_name: { type: 'string' },
          subject: { type: 'string' },
          html_body: { type: 'string' },
          text_body: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      TemplateInput: {
        type: 'object',
        required: ['templateCode', 'templateName', 'subject', 'htmlBody'],
        properties: {
          templateCode: { type: 'string', example: 'welcome_email' },
          templateName: { type: 'string', example: 'Welcome Email' },
          subject: { type: 'string', example: 'Welcome {{first_name}}!' },
          htmlBody: { type: 'string', example: '<p>Hi {{first_name}}, welcome to {{company_name}}.</p>' },
          textBody: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
        },
      },
      Recipient: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string', nullable: true },
          lastName: { type: 'string', nullable: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      CampaignBase: {
        type: 'object',
        required: ['campaignName', 'templateId', 'fromEmail'],
        properties: {
          campaignName: { type: 'string' },
          templateId: { type: 'integer' },
          fromEmail: { type: 'string', format: 'email' },
          replyTo: { type: 'string', format: 'email', nullable: true },
          globalVars: { type: 'object', additionalProperties: true },
        },
      },
      CampaignSendApi: {
        allOf: [
          { $ref: '#/components/schemas/CampaignBase' },
          {
            type: 'object',
            required: ['recipients'],
            properties: {
              recipients: { type: 'array', items: { $ref: '#/components/schemas/Recipient' } },
            },
          },
        ],
      },
      CampaignSendDb: {
        allOf: [
          { $ref: '#/components/schemas/CampaignBase' },
          {
            type: 'object',
            required: ['tableName', 'emailColumn'],
            properties: {
              tableName: { type: 'string', example: 'crm_leads' },
              emailColumn: { type: 'string', example: 'email' },
              firstNameColumn: { type: 'string', example: 'fname' },
              lastNameColumn: { type: 'string', example: 'lname' },
              whereClause: { type: 'string', example: "status = 'ACTIVE'" },
              limit: { type: 'integer' },
            },
          },
        ],
      },
      CampaignSendQuery: {
        allOf: [
          { $ref: '#/components/schemas/CampaignBase' },
          {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string', example: 'SELECT email, fname AS first_name FROM crm_leads WHERE city = "Delhi"' },
              limit: { type: 'integer' },
            },
          },
        ],
      },
      Campaign: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          campaign_name: { type: 'string' },
          template_id: { type: 'integer' },
          status: { type: 'string', enum: ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'] },
          total_recipients: { type: 'integer' },
          sent_count: { type: 'integer' },
          failed_count: { type: 'integer' },
          bounced_count: { type: 'integer' },
          complaint_count: { type: 'integer' },
          delivered_count: { type: 'integer' },
        },
      },
      CampaignStats: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          status: { type: 'string' },
          counters: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              queued: { type: 'integer' },
              sent: { type: 'integer' },
              failed: { type: 'integer' },
              bounced: { type: 'integer' },
              complaints: { type: 'integer' },
              delivered: { type: 'integer' },
              suppressed: { type: 'integer' },
            },
          },
          recipientStatusBreakdown: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
      SuppressionEntry: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          reason: { type: 'string', enum: ['BOUNCE', 'COMPLAINT', 'MANUAL', 'UNSUBSCRIBE'] },
          notes: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Authenticated but insufficient role',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      ValidationError: {
        description: 'Request validation failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Templates' },
    { name: 'Campaigns' },
    { name: 'Suppression' },
    { name: 'Webhooks' },
  ],
  paths: {
    '/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        security: [],
        responses: {
          '200': {
            description: 'Process is alive',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe (DB connectivity)',
        security: [],
        responses: {
          '200': { description: 'Ready' },
          '503': { description: 'Not ready' },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: { '200': { description: 'Healthy' }, '503': { description: 'Unhealthy' } },
      },
    },

    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login with email + password',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Return decoded JWT payload (or null)',
        responses: {
          '200': { description: 'Current user' },
        },
      },
    },

    '/api/templates': {
      get: {
        tags: ['Templates'],
        summary: 'List templates',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' } },
          { in: 'query', name: 'limit', schema: { type: 'integer' } },
          { in: 'query', name: 'offset', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Template' } } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Templates'],
        summary: 'Create a template',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/TemplateInput' } } },
        },
        responses: {
          '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': { description: 'Template code already exists' },
        },
      },
    },
    '/api/templates/{id}': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      get: {
        tags: ['Templates'],
        summary: 'Get a template by id',
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        tags: ['Templates'],
        summary: 'Update a template (partial)',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TemplateInput' } } } },
        responses: { '200': { description: 'Updated' }, '404': { $ref: '#/components/responses/NotFound' } },
      },
      delete: {
        tags: ['Templates'],
        summary: 'Delete a template (admin only)',
        responses: { '204': { description: 'Deleted' }, '403': { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/api/templates/{id}/preview': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      post: {
        tags: ['Templates'],
        summary: 'Render a template with provided variables',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { vars: { type: 'object', additionalProperties: true } },
              },
              example: { vars: { company_name: 'ACME Pvt Ltd' } },
            },
          },
        },
        responses: {
          '200': {
            description: 'Rendered',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    subject: { type: 'string' },
                    htmlBody: { type: 'string' },
                    textBody: { type: 'string', nullable: true },
                    missingPlaceholders: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/campaigns/send': {
      post: {
        tags: ['Campaigns'],
        summary: 'Create a campaign with an inline recipient list',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignSendApi' } } },
        },
        responses: {
          '202': {
            description: 'Accepted (campaign queued)',
            content: { 'application/json': { schema: { type: 'object', properties: { campaignId: { type: 'integer' }, stats: { type: 'object' } } } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/campaigns/send-from-db': {
      post: {
        tags: ['Campaigns'],
        summary: 'Create a campaign sourcing recipients from a whitelisted table',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignSendDb' } } } },
        responses: { '202': { description: 'Accepted' }, '400': { $ref: '#/components/responses/ValidationError' } },
      },
    },
    '/api/campaigns/send-from-query': {
      post: {
        tags: ['Campaigns'],
        summary: 'Create a campaign with a custom SELECT query (admin only, ALLOW_RAW_QUERY=true)',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignSendQuery' } } } },
        responses: {
          '202': { description: 'Accepted' },
          '400': { description: 'Disabled or query rejected' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/api/campaigns': {
      get: {
        tags: ['Campaigns'],
        summary: 'List campaigns',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' } },
          { in: 'query', name: 'limit', schema: { type: 'integer' } },
          { in: 'query', name: 'offset', schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Campaign' } } } } },
        },
      },
    },
    '/api/campaigns/{id}': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      get: { tags: ['Campaigns'], summary: 'Get a campaign', responses: { '200': { description: 'OK' }, '404': { $ref: '#/components/responses/NotFound' } } },
    },
    '/api/campaigns/{id}/stats': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      get: {
        tags: ['Campaigns'],
        summary: 'Live stats for a campaign',
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/CampaignStats' } } } } },
      },
    },
    '/api/campaigns/{id}/recipients': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      get: {
        tags: ['Campaigns'],
        summary: 'List campaign recipients',
        parameters: [
          { in: 'query', name: 'status', schema: { type: 'string' } },
          { in: 'query', name: 'limit', schema: { type: 'integer' } },
          { in: 'query', name: 'offset', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/campaigns/{id}/pause': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      post: { tags: ['Campaigns'], summary: 'Pause a running campaign', responses: { '200': { description: 'Paused' } } },
    },
    '/api/campaigns/{id}/resume': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      post: { tags: ['Campaigns'], summary: 'Resume a paused campaign', responses: { '200': { description: 'Resumed' } } },
    },
    '/api/campaigns/{id}/cancel': {
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
      post: { tags: ['Campaigns'], summary: 'Cancel a campaign (admin only)', responses: { '200': { description: 'Cancelled' } } },
    },
    '/api/campaigns/test-send': {
      post: {
        tags: ['Campaigns'],
        summary: 'Send a single test email using a template',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['templateId', 'fromEmail', 'toEmail'],
                properties: {
                  templateId: { type: 'integer' },
                  fromEmail: { type: 'string', format: 'email' },
                  toEmail: { type: 'string', format: 'email' },
                  vars: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Sent' } },
      },
    },

    '/api/suppression': {
      get: { tags: ['Suppression'], summary: 'List suppression entries', responses: { '200': { description: 'OK' } } },
      post: {
        tags: ['Suppression'],
        summary: 'Add an email to the suppression list',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  reason: { type: 'string', enum: ['BOUNCE', 'COMPLAINT', 'MANUAL', 'UNSUBSCRIBE'] },
                  notes: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/suppression/{email}': {
      parameters: [{ in: 'path', name: 'email', required: true, schema: { type: 'string' } }],
      delete: { tags: ['Suppression'], summary: 'Remove from suppression (admin only)', responses: { '204': { description: 'Removed' } } },
    },

    [env.WEBHOOK_PATH]: {
      post: {
        tags: ['Webhooks'],
        summary: 'SNS webhook for SES events (subscription confirmation + notifications)',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'OK' }, '400': { description: 'Invalid envelope' } },
      },
    },
  },
} as const;
