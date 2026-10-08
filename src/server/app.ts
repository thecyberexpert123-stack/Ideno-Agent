import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Services } from './container.js';
import { errorHandler, notFoundHandler, securityHeaders } from './http.js';
import { caseRoutes } from './routes/cases.js';
import { researchRoutes } from './routes/research.js';
import { systemRoutes } from './routes/system.js';

/**
 * Builds the Express application.
 *
 * The API is same-origin only: in development Vite proxies `/api` to this
 * server, and in production this server also serves the built client. There
 * is therefore no CORS configuration, and no provider credential is ever sent
 * to a browser.
 */
export function createApp(services: Services): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Idea text and changeset decisions are small; a tight cap limits the blast
  // radius of a malformed or hostile request.
  app.use(express.json({ limit: '512kb' }));

  app.use('/api', systemRoutes(services));
  app.use('/api', caseRoutes(services));
  app.use('/api', researchRoutes(services));

  app.use('/api', notFoundHandler);

  if (services.config.serveUi && existsSync(join(services.config.resolvedUiDir, 'index.html'))) {
    const uiDir = services.config.resolvedUiDir;
    app.use(express.static(uiDir, { index: false, maxAge: '1h' }));
    // Single-page app fallback for client-side routes.
    app.get(/^(?!\/api\/).*/u, (_request, response) => {
      response.sendFile(join(uiDir, 'index.html'));
    });
  }

  app.use(errorHandler(services.logger));
  return app;
}
