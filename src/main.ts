/**
 * Entry point.
 *
 * Boots the app into #app. Everything else — storage, providers, plugins, the
 * orchestrator — is composed inside `IdenoApp`, so this file stays trivial and
 * there is exactly one place to look for how the application is assembled.
 */
import './ui/styles.css';
import { createApp } from './ui/app.js';

function boot(): void {
  const mount = document.getElementById('app');
  if (!mount) {
    // Without a mount point there is nothing to render into; say so loudly
    // rather than failing silently in a console nobody is watching.
    document.body.textContent = 'Ideno could not start: the #app mount point is missing from this page.';
    return;
  }

  const app = createApp(mount);
  app.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    mount.replaceChildren(
      Object.assign(document.createElement('pre'), {
        textContent: `Ideno failed to start: ${message}`,
      }),
    );
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
