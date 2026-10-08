import { createApp } from './app.js';
import { describeConfig, loadConfig } from './config.js';
import { buildServices } from './container.js';

/**
 * Server entry point.
 *
 * Also the one place that installs process-level guards. These are not
 * decoration: the Puter SDK issues background requests during initialisation
 * whose rejection is not observable by the caller, and Node terminates the
 * process on an unhandled rejection by default. Logging and continuing keeps
 * a reachable provider failure from taking the whole application down.
 */
function main(): void {
  const config = loadConfig();
  const services = buildServices(config);
  const app = createApp(services);

  process.on('unhandledRejection', (reason) => {
    services.logger.log('error', 'unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (error) => {
    services.logger.log('error', 'uncaught exception', { message: error.message });
  });

  const server = app.listen(config.port, config.host, () => {
    services.logger.log('info', 'Ideno API listening', {
      url: `http://${config.host}:${config.port}`,
      ...describeConfig(config),
    });
    if (!services.runtime.isReady) {
      services.logger.log('warn', 'no AI provider is configured — Ideno cannot reason yet', {
        providers: services.runtime.listProviders().map((provider) => provider.detail),
      });
    }
  });

  const shutdown = (signal: string): void => {
    services.logger.log('info', 'shutting down', { signal });
    server.close(() => process.exit(0));
    // Force exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
