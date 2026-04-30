import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './spec.js';

export const mountSwagger = (app: Express) => {
  app.get('/api-docs.json', (_req, res) => res.json(openApiSpec));

  // Mount the same UI at both /swagger and /api-docs.
  const ui = swaggerUi.serve;
  const setup = swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'BSERC Email API',
    swaggerOptions: { persistAuthorization: true },
  });
  app.use('/swagger', ui, setup);
  app.use('/api-docs', ui, setup);
};
