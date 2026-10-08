import { Router } from 'express';
import type { Services } from '../container.js';
import { describeConfig } from '../config.js';

/** Health and capability discovery. The UI reads this on boot. */
export function systemRoutes(services: Services): Router {
  const router = Router();

  router.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      version: '0.1.0',
      aiReady: services.runtime.isReady,
    });
  });

  router.get('/capabilities', (_request, response) => {
    response.json({
      version: '0.1.0',
      config: describeConfig(services.config),
      ai: {
        ready: services.runtime.isReady,
        activeProvider: services.runtime.activeProviderId(),
        providers: services.runtime.listProviders(),
      },
      plugins: services.plugins.list(),
    });
  });

  return router;
}
